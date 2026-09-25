// The Decisions queue (Phase 6a): Escalations (parked uncertain subjects) and
// Spot checks (a daily blind sample of the guard's clear verdicts), as cards
// for a parent. Reads join candidate_pool and requests; every write to those
// goes through the owning module (decide.ts).
import { db } from '../../db/client';
import {
  cleanDescription,
  readVideoMetadata,
  shownEvalForCandidate,
  shownEvalForRequest,
  type ShownEval,
} from '../guard';
import { getAgeBand } from '../users';
import {
  CATCH_UP_BATCH_MIX,
  CATCH_UP_PAGE,
  DAILY_CARD_CAP,
  ESCALATION_RECENT_DAYS,
  SPOT_CHECK_MIX,
  SPOT_CHECK_WINDOW_DAYS,
  daysBefore,
  drawSample,
  groupBy,
  groupKey,
  hash32,
  prng,
  utcDay,
  type DecisionSource,
  type SubjectType,
} from './util';

const DESCRIPTION_CARD_CHARS = 600;

interface SubjectRow {
  subject_type: SubjectType;
  subject_id: string;
  user_id: string;
  kid_name: string;
  url: string;
  youtube_id: string | null;
  title: string | null;
  channel: string | null;
  guard_verdict: string | null;
  added_at: string;
  description: string | null;
}

export interface CardSubject {
  subjectType: SubjectType;
  subjectId: string;
  userId: string;
  kidName: string;
  ageBand: string;
  // Escalations only. A Spot check's verdict stays hidden until the parent
  // answers; the decision response reveals it.
  guard: ShownEval | null;
}

export interface DecisionCard {
  key: string;
  source: DecisionSource;
  url: string;
  youtubeId: string | null;
  title: string;
  channel: string | null;
  description: string;
  thumbnailUrl: string | null;
  addedAt: string;
  subjects: CardSubject[];
}

export interface DecisionQueue {
  mode: 'today' | 'catch_up';
  focus: 'escalations' | 'spot_checks' | null;
  cards: DecisionCard[];
  counts: {
    escalations: number;        // undecided, any age
    escalationsRecent: number;  // undecided, within the daily window
    spotChecksToday: number;    // undecided of today's draw
  };
}

const NOT_DECIDED = (alias: string, type: SubjectType, idCol: string) => `
  NOT EXISTS (SELECT 1 FROM guard_decisions d
               WHERE d.subject_type = '${type}' AND d.subject_id = ${alias}.${idCol})`;

// Parked uncertain subjects for kids: discovery candidates the guard parked,
// and downloaded slate picks the second pass parked. Newest first.
function readEscalations(since: string): SubjectRow[] {
  return db.prepare(`
    SELECT 'candidate' AS subject_type, cp.candidate_id AS subject_id, cp.user_id,
           u.display_name AS kid_name, cp.url, cp.external_id AS youtube_id,
           cp.title, cp.channel, cp.guard_verdict, cp.created_at AS added_at,
           NULL AS description
      FROM candidate_pool cp
      JOIN users u ON u.user_id = cp.user_id
     WHERE u.role = 'kid' AND cp.status = 'guard_pending' AND cp.created_at >= @since
       AND ${NOT_DECIDED('cp', 'candidate', 'candidate_id')}
    UNION ALL
    SELECT 'request', r.request_id, r.user_id, u.display_name, r.url, r.youtube_id,
           r.title, r.channel, r.guard_verdict, r.requested_at, r.description
      FROM requests r
      JOIN users u ON u.user_id = r.user_id
     WHERE u.role = 'kid' AND r.status = 'guard_pending' AND r.requested_at >= @since
       AND ${NOT_DECIDED('r', 'request', 'request_id')}
     ORDER BY added_at DESC, subject_id
  `).all({ since }) as SubjectRow[];
}

function countEscalations(since: string): number {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM candidate_pool cp JOIN users u ON u.user_id = cp.user_id
        WHERE u.role = 'kid' AND cp.status = 'guard_pending' AND cp.created_at >= @since
          AND ${NOT_DECIDED('cp', 'candidate', 'candidate_id')})
      +
      (SELECT COUNT(*) FROM requests r JOIN users u ON u.user_id = r.user_id
        WHERE u.role = 'kid' AND r.status = 'guard_pending' AND r.requested_at >= @since
          AND ${NOT_DECIDED('r', 'request', 'request_id')}) AS n
  `).get({ since }) as { n: number };
  return row.n;
}

// Undecided drawn subjects for a day and source, in draw order.
function readDrawn(day: string, source: 'spot_check' | 'catch_up'): SubjectRow[] {
  return db.prepare(`
    SELECT s.subject_type, s.subject_id, s.user_id, u.display_name AS kid_name,
           COALESCE(cp.url, r.url) AS url,
           COALESCE(cp.external_id, r.youtube_id) AS youtube_id,
           COALESCE(cp.title, r.title) AS title,
           COALESCE(cp.channel, r.channel) AS channel,
           s.guard_verdict, s.created_at AS added_at, r.description
      FROM guard_spot_checks s
      JOIN users u ON u.user_id = s.user_id
      LEFT JOIN candidate_pool cp ON s.subject_type = 'candidate' AND cp.candidate_id = s.subject_id
      LEFT JOIN requests r        ON s.subject_type = 'request'   AND r.request_id   = s.subject_id
     WHERE s.day = @day AND s.source = @source
       AND (cp.candidate_id IS NOT NULL OR r.request_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM guard_decisions d
                        WHERE d.subject_type = s.subject_type AND d.subject_id = s.subject_id)
     ORDER BY s.created_at, s.subject_id
  `).all({ day, source }) as SubjectRow[];
}

interface PoolRow {
  subject_type: SubjectType;
  subject_id: string;
  user_id: string;
  guard_verdict: 'clear_yes' | 'clear_no';
}

// Subjects a draw may pick: kids' candidates and requests carrying a clear
// guard verdict since `from`, not yet decided (for that kid and video, under
// any subject) and not already drawn today. Picked candidates ('requested')
// are left to their request, which carries the download-time verdict.
// Kid-initiated requests are in: they are shadow-mode, so a Spot check on one
// records a label only.
function readDrawPool(from: string, day: string): PoolRow[] {
  const decidedVideo = (alias: string, ytCol: string) => `
    NOT EXISTS (SELECT 1 FROM guard_decisions d
                 WHERE d.user_id = ${alias}.user_id AND d.youtube_id = ${alias}.${ytCol})`;
  const notDrawnToday = (alias: string, type: SubjectType, idCol: string) => `
    NOT EXISTS (SELECT 1 FROM guard_spot_checks s
                 WHERE s.day = @day AND s.subject_type = '${type}' AND s.subject_id = ${alias}.${idCol})`;
  return db.prepare(`
    SELECT 'candidate' AS subject_type, cp.candidate_id AS subject_id, cp.user_id, cp.guard_verdict
      FROM candidate_pool cp
      JOIN users u ON u.user_id = cp.user_id
     WHERE u.role = 'kid'
       AND cp.guard_verdict IN ('clear_yes', 'clear_no')
       AND cp.status IN ('scored', 'surfaced', 'guard_rejected')
       AND COALESCE(cp.scored_at, cp.created_at) >= @from
       AND ${NOT_DECIDED('cp', 'candidate', 'candidate_id')}
       AND ${decidedVideo('cp', 'external_id')}
       AND ${notDrawnToday('cp', 'candidate', 'candidate_id')}
    UNION ALL
    SELECT 'request', r.request_id, r.user_id, r.guard_verdict
      FROM requests r
      JOIN users u ON u.user_id = r.user_id
     WHERE u.role = 'kid'
       AND r.guard_verdict IN ('clear_yes', 'clear_no')
       AND r.status IN ('ready', 'watched')
       AND r.requested_at >= @from
       AND ${NOT_DECIDED('r', 'request', 'request_id')}
       AND ${decidedVideo('r', 'youtube_id')}
       AND ${notDrawnToday('r', 'request', 'request_id')}
  `).all({ from, day }) as PoolRow[];
}

// Draw one batch into guard_spot_checks. Deterministic for a given day,
// source and batch number, so a retried draw picks the same subjects.
function drawBatch(
  now: Date,
  source: 'spot_check' | 'catch_up',
  from: string,
  mix: { clear_yes: number; clear_no: number },
): number {
  const day = utcDay(now);
  const tx = db.transaction(() => {
    const batch = (db.prepare(
      'SELECT COUNT(*) AS n FROM guard_spot_checks WHERE day = ? AND source = ?',
    ).get(day, source) as { n: number }).n;
    const rand = prng(hash32(`${day}:${source}:${batch}`));
    const pool = readDrawPool(from, day);
    const key = (r: PoolRow) => `${r.subject_type}:${r.subject_id}`;
    const picks = [
      ...drawSample(pool.filter((r) => r.guard_verdict === 'clear_yes'), mix.clear_yes, key, rand),
      ...drawSample(pool.filter((r) => r.guard_verdict === 'clear_no'), mix.clear_no, key, rand),
    ];
    const insert = db.prepare(`
      INSERT OR IGNORE INTO guard_spot_checks
        (day, subject_type, subject_id, user_id, source, guard_verdict, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // Shuffle the mix so the clear-no isn't always last.
    const ordered = drawSample(picks, picks.length, key, rand);
    ordered.forEach((p, i) => {
      // created_at orders the day's cards; offset keeps the draw order.
      const at = new Date(now.getTime() + i).toISOString();
      insert.run(day, p.subject_type, p.subject_id, p.user_id, source, p.guard_verdict, at);
    });
    return ordered.length;
  });
  return tx();
}

// Today's Spot checks are drawn once, on the first queue read of the UTC day.
function ensureTodaysSpotChecks(now: Date): void {
  const drawn = db.prepare(
    `SELECT 1 FROM guard_spot_checks WHERE day = ? AND source = 'spot_check' LIMIT 1`,
  ).get(utcDay(now));
  if (!drawn) drawBatch(now, 'spot_check', daysBefore(now, SPOT_CHECK_WINDOW_DAYS), SPOT_CHECK_MIX);
}

function descriptionFor(row: SubjectRow): string {
  const stored = row.youtube_id ? readVideoMetadata(row.youtube_id)?.description : null;
  const cleaned = cleanDescription(stored ?? row.description ?? '');
  return cleaned.length > DESCRIPTION_CARD_CHARS ? `${cleaned.slice(0, DESCRIPTION_CARD_CHARS)}...` : cleaned;
}

function toCards(rows: SubjectRow[], source: DecisionSource, ageBands: Map<string, string>): DecisionCard[] {
  const bandFor = (userId: string): string => {
    let band = ageBands.get(userId);
    if (!band) {
      band = getAgeBand(userId);
      ageBands.set(userId, band);
    }
    return band;
  };
  return groupBy(rows, (r) => groupKey(source, r.youtube_id, r.url)).map((group) => {
    const first = group[0]!;
    return {
      key: groupKey(source, first.youtube_id, first.url),
      source,
      url: first.url,
      youtubeId: first.youtube_id,
      title: first.title ?? '(untitled)',
      channel: first.channel,
      description: descriptionFor(first),
      // Parent-facing: the creator thumbnail is fine here.
      thumbnailUrl: first.youtube_id ? `https://i.ytimg.com/vi/${first.youtube_id}/mqdefault.jpg` : null,
      addedAt: first.added_at,
      subjects: group.map((r) => ({
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        userId: r.user_id,
        kidName: r.kid_name,
        ageBand: bandFor(r.user_id),
        guard: source !== 'escalation' ? null
          : r.subject_type === 'request'
            ? shownEvalForRequest(r.subject_id)
            : shownEvalForCandidate(r.subject_id, r.url, r.guard_verdict),
      })),
    };
  });
}

export interface QueueOptions {
  mode: 'today' | 'catch_up';
  // Catch-up only: which pile to work through. Defaults to escalations.
  focus?: 'escalations' | 'spot_checks';
  now?: Date;
}

export function readDecisionQueue(opts: QueueOptions): DecisionQueue {
  const now = opts.now ?? new Date();
  const day = utcDay(now);
  const recentSince = daysBefore(now, ESCALATION_RECENT_DAYS);
  ensureTodaysSpotChecks(now);
  const bands = new Map<string, string>();
  const counts = {
    escalations: countEscalations(''),
    escalationsRecent: countEscalations(recentSince),
    spotChecksToday: readDrawn(day, 'spot_check').length,
  };

  if (opts.mode === 'today') {
    // Escalations first, then today's Spot checks, capped by card. The
    // Spot checks keep their slots inside the cap: they are the blind labels,
    // and a backlog of escalations would otherwise crowd them out every day.
    const spotChecks = toCards(readDrawn(day, 'spot_check'), 'spot_check', bands).slice(0, DAILY_CARD_CAP);
    const escalations = toCards(readEscalations(recentSince), 'escalation', bands)
      .slice(0, DAILY_CARD_CAP - spotChecks.length);
    const cards = [...escalations, ...spotChecks];
    return { mode: 'today', focus: null, cards, counts };
  }

  const focus = opts.focus ?? 'escalations';
  if (focus === 'escalations') {
    const cards = toCards(readEscalations(''), 'escalation', bands).slice(0, CATCH_UP_PAGE);
    return { mode: 'catch_up', focus, cards, counts };
  }

  // Spot checks: today's first, then catch-up draws from all history, a
  // batch at a time whenever the undrawn catch-up rows run out.
  let catchUp = readDrawn(day, 'catch_up');
  if (catchUp.length === 0) {
    drawBatch(now, 'catch_up', '', CATCH_UP_BATCH_MIX);
    catchUp = readDrawn(day, 'catch_up');
  }
  const cards = [
    ...toCards(readDrawn(day, 'spot_check'), 'spot_check', bands),
    ...toCards(catchUp, 'catch_up', bands),
  ].slice(0, CATCH_UP_PAGE);
  return { mode: 'catch_up', focus, cards, counts };
}
