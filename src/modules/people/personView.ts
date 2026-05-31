import { db } from '../../db/client';
import { NotFoundError } from '../../errors';
import { toPublicMediaUrl } from '../media';

export interface PersonViewItem {
  request_id: string;
  title: string | null;
  channel: string | null;
  youtube_id: string | null;
  youtube_channel_id: string | null;
  url: string;
  status: string;
  file_state: string;
  nginx_url: string | null;
  thumbnail_url: string | null;
  duration_secs: number | null;
  why_text: string | null;
  rejection_reason: string | null;
  requested_at: string;
  added_at: string;
  watched_at: string | null;
  saved_at: string | null;
  source: string;
}

export interface PersonViewPerson {
  personId: string;
  displayName: string;
  personType: string | null;
  photoUrl: string | null;
  bio: string | null;
  channelId: string | null;
}

export type SupportKind =
  | 'patreon'
  | 'substack'
  | 'bandcamp'
  | 'kofi'
  | 'bookshop'
  | 'merch'
  | 'other';

export interface PersonViewSupport {
  kind: SupportKind;
  label: string;
  url: string;
}

export interface PersonView {
  person: PersonViewPerson;
  items: PersonViewItem[];
  support: PersonViewSupport[];
  followedAt: string | null;
}

export interface PersonSummary {
  personId: string;
  displayName: string;
  photoUrl: string | null;
  followedAt: string | null;
}

const ITEMS_CAP = 6;

// Items considered "in library" for this person view: the kid either has the
// file, has watched it, or actively dismissed it. Broader than the timeline
// feed (which hides dismissed) — on a person page, "I dismissed this one"
// is part of the relationship the page is reflecting.
const IN_LIBRARY_STATUSES = ['ready', 'watched', 'dismissed'] as const;

interface PersonRow {
  person_id: string;
  display_name: string;
  person_type: string | null;
  photo_url: string | null;
  bio: string | null;
  support_urls: string | null;
  channel_id: string | null;
}

export function getPersonView(personId: string, userId: string): PersonView {
  const personRow = db.prepare(`
    SELECT p.person_id, p.display_name, p.person_type, p.photo_url, p.bio, p.support_urls,
           po.external_id AS channel_id
    FROM people p
    LEFT JOIN person_outputs po ON po.person_id = p.person_id AND po.output_type = 'youtube'
    WHERE p.person_id = ?
    LIMIT 1
  `).get(personId) as PersonRow | undefined;

  if (!personRow) throw new NotFoundError(`person ${personId}`);

  const followRow = db.prepare(
    'SELECT followed_at FROM followed_people WHERE user_id = ? AND person_id = ?'
  ).get(userId, personId) as { followed_at: string } | undefined;

  const placeholders = IN_LIBRARY_STATUSES.map(() => '?').join(', ');
  const items = db.prepare(`
    SELECT request_id, title, channel, youtube_id, youtube_channel_id, url, status, file_state,
           nginx_url, thumbnail_url, duration_secs, why_text, rejection_reason,
           requested_at, added_at, watched_at, saved_at, source
    FROM requests
    WHERE user_id = ?
      AND channel = ?
      AND status IN (${placeholders})
    ORDER BY added_at DESC
    LIMIT ?
  `).all(userId, personRow.display_name, ...IN_LIBRARY_STATUSES, ITEMS_CAP) as PersonViewItem[];

  for (const item of items) {
    item.nginx_url = toPublicMediaUrl(item.nginx_url);
    item.thumbnail_url = toPublicMediaUrl(item.thumbnail_url);
  }

  return {
    person: {
      personId: personRow.person_id,
      displayName: personRow.display_name,
      personType: personRow.person_type,
      photoUrl: personRow.photo_url,
      bio: personRow.bio,
      channelId: personRow.channel_id,
    },
    items,
    support: parseSupportUrls(personRow.support_urls),
    followedAt: followRow?.followed_at ?? null,
  };
}

// Lightweight Person lookup for the player's Person row (#138): resolve a
// YouTube channel to its existing Person plus this user's follow state, without
// the items/support payload getPersonView assembles. Read-only — unlike POST
// /people/resolve it never creates a Person row or fires bio/photo capture, so
// it's safe to call on every video-detail open. Returns null when no Person
// exists for the channel yet; the caller falls back to the channel name it
// already holds and renders the "Not followed" branch.
export function getPersonSummaryByChannel(channelId: string, userId: string): PersonSummary | null {
  const row = db.prepare(`
    SELECT p.person_id, p.display_name, p.photo_url, fp.followed_at
    FROM person_outputs po
    INNER JOIN people p ON p.person_id = po.person_id
    LEFT JOIN followed_people fp ON fp.person_id = p.person_id AND fp.user_id = ?
    WHERE po.output_type = 'youtube' AND po.external_id = ?
    LIMIT 1
  `).get(userId, channelId) as
    | { person_id: string; display_name: string; photo_url: string | null; followed_at: string | null }
    | undefined;

  if (!row) return null;
  return {
    personId: row.person_id,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    followedAt: row.followed_at,
  };
}

// support_urls is a free-form TEXT column. Bio/photo capture (#41) populates
// it on a best-effort basis; the shape that lands there is "JSON, probably,
// possibly an array of strings, possibly objects". Parse permissively, drop
// anything that isn't a usable URL.
export function parseSupportUrls(raw: string | null | undefined): PersonViewSupport[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: PersonViewSupport[] = [];
  for (const entry of parsed) {
    let url: string | null = null;
    let explicitKind: string | null = null;

    if (typeof entry === 'string') {
      url = entry;
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.url === 'string') url = obj.url;
      if (typeof obj.kind === 'string') explicitKind = obj.kind;
    }

    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const kind = (explicitKind && isSupportKind(explicitKind)) ? explicitKind : classifyByHost(url);
    out.push({ kind, label: labelFor(kind), url });
  }
  return out;
}

const KIND_HOSTS: Array<{ kind: SupportKind; match: RegExp }> = [
  { kind: 'patreon',  match: /(^|\.)patreon\.com$/i },
  { kind: 'substack', match: /(^|\.)substack\.com$/i },
  { kind: 'bandcamp', match: /(^|\.)bandcamp\.com$/i },
  { kind: 'kofi',     match: /(^|\.)ko-fi\.com$/i },
  { kind: 'bookshop', match: /(^|\.)bookshop\.org$/i },
];

function classifyByHost(url: string): SupportKind {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return 'other';
  }
  for (const entry of KIND_HOSTS) {
    if (entry.match.test(host)) return entry.kind;
  }
  return 'other';
}

function isSupportKind(value: string): value is SupportKind {
  return ['patreon', 'substack', 'bandcamp', 'kofi', 'bookshop', 'merch', 'other'].includes(value);
}

function labelFor(kind: SupportKind): string {
  switch (kind) {
    case 'patreon':  return 'Patreon';
    case 'substack': return 'Substack';
    case 'bandcamp': return 'Bandcamp';
    case 'kofi':     return 'Ko-fi';
    case 'bookshop': return 'Bookshop.org';
    case 'merch':    return 'Merch';
    case 'other':    return 'Link';
  }
}

// Allowlist of kinds visible to kid users — anything else stays hidden on the
// kid surface. Adults see everything.
const KID_VISIBLE_KINDS: ReadonlySet<SupportKind> = new Set([
  'patreon', 'substack', 'bandcamp', 'kofi', 'bookshop', 'merch',
]);

export function isKidVisibleSupport(kind: SupportKind): boolean {
  return KID_VISIBLE_KINDS.has(kind);
}
