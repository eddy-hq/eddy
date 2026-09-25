// Stored Data API metadata for the candidate guard (Phase 6a). The guard owns
// `video_metadata`: the rows exist only to feed guard prompts and the
// age-restricted short-circuit, so the table and its reads/writes sit here
// rather than in discovery, which merely calls in before its guard loop.
import { db } from '../../db/client';
import { logger } from '../../logger';
import { videoMetadata, type VideoMetadata } from '../../discovery-metadata';

export interface StoredVideoMetadata {
  youtubeId: string;
  description: string | null;
  tags: string[];
  categoryId: string | null;
  ageRestricted: boolean;
  madeForKids: boolean | null;
}

interface VideoMetadataRow {
  youtube_id: string;
  description: string | null;
  tags_json: string | null;
  category_id: string | null;
  age_restricted: number;
  made_for_kids: number | null;
}

// videos.list takes at most 50 ids per call.
const FETCH_BATCH = 50;

// The categories an uploader can assign (videoCategories.list, assignable =
// true). The rest of the list is legacy or channel-level and never appears on
// a video; an id outside this map is left out of the prompt rather than shown
// as a bare number.
const CATEGORY_NAMES: Record<string, string> = {
  '1': 'Film & Animation',
  '2': 'Autos & Vehicles',
  '10': 'Music',
  '15': 'Pets & Animals',
  '17': 'Sports',
  '19': 'Travel & Events',
  '20': 'Gaming',
  '22': 'People & Blogs',
  '23': 'Comedy',
  '24': 'Entertainment',
  '25': 'News & Politics',
  '26': 'Howto & Style',
  '27': 'Education',
  '28': 'Science & Technology',
  '29': 'Nonprofits & Activism',
};

export function categoryName(categoryId: string | null | undefined): string | null {
  if (!categoryId) return null;
  return CATEGORY_NAMES[categoryId] ?? null;
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function fromRow(row: VideoMetadataRow): StoredVideoMetadata {
  return {
    youtubeId: row.youtube_id,
    description: row.description,
    tags: parseTags(row.tags_json),
    categoryId: row.category_id,
    ageRestricted: row.age_restricted === 1,
    madeForKids: row.made_for_kids === null ? null : row.made_for_kids === 1,
  };
}

function readStored(ids: string[]): Map<string, StoredVideoMetadata> {
  const out = new Map<string, StoredVideoMetadata>();
  if (ids.length === 0) return out;
  const rows = db.prepare(`
    SELECT youtube_id, description, tags_json, category_id, age_restricted, made_for_kids
    FROM video_metadata
    WHERE youtube_id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(ids)) as VideoMetadataRow[];
  for (const row of rows) out.set(row.youtube_id, fromRow(row));
  return out;
}

function persist(fetched: VideoMetadata[], fetchedAt: string): void {
  const upsert = db.prepare(`
    INSERT INTO video_metadata
      (youtube_id, description, tags_json, category_id, age_restricted, made_for_kids, fetched_at)
    VALUES
      (@youtube_id, @description, @tags_json, @category_id, @age_restricted, @made_for_kids, @fetched_at)
    ON CONFLICT(youtube_id) DO UPDATE SET
      description    = excluded.description,
      tags_json      = excluded.tags_json,
      category_id    = excluded.category_id,
      age_restricted = excluded.age_restricted,
      made_for_kids  = excluded.made_for_kids,
      fetched_at     = excluded.fetched_at
  `);
  db.transaction((items: VideoMetadata[]) => {
    for (const m of items) {
      upsert.run({
        youtube_id: m.videoId,
        description: m.description,
        tags_json: m.tags.length > 0 ? JSON.stringify(m.tags) : null,
        category_id: m.categoryId,
        age_restricted: m.ageRestricted ? 1 : 0,
        made_for_kids: m.madeForKids === null ? null : m.madeForKids ? 1 : 0,
        fetched_at: fetchedAt,
      });
    }
  })(fetched);
}

// Return stored metadata for `youtubeIds`, first fetching and persisting rows
// for any id that lacks one. Never throws: a fetch failure, a quota
// stand-down or a DB error logs at warn and returns whatever is already
// stored, so the guard falls back to its existing inputs for the rest. Ids the
// API omits (removed / private) get no row and are absent from the result.
export async function ensureVideoMetadata(
  youtubeIds: string[],
): Promise<Map<string, StoredVideoMetadata>> {
  const ids = [...new Set(youtubeIds.filter((id) => id))];
  let stored = new Map<string, StoredVideoMetadata>();
  try {
    stored = readStored(ids);
  } catch (err) {
    logger.warn({ err }, 'Guard metadata: failed to read stored video metadata');
    return stored;
  }

  const missing = ids.filter((id) => !stored.has(id));
  for (let i = 0; i < missing.length; i += FETCH_BATCH) {
    const batch = missing.slice(i, i + FETCH_BATCH);
    let fetched: Map<string, VideoMetadata> | null;
    try {
      fetched = await videoMetadata(batch);
    } catch (err) {
      if ((err as { quotaExceeded?: boolean }).quotaExceeded) {
        logger.warn(
          { remaining: missing.length - i },
          'Guard metadata: YouTube Data API quota exhausted — guarding the rest on existing inputs',
        );
      } else {
        logger.warn(
          { err, remaining: missing.length - i },
          'Guard metadata: video metadata fetch failed — guarding the rest on existing inputs',
        );
      }
      break;
    }
    // Null means the configured source has no metadata read (yt-dlp fallback).
    if (fetched === null) break;

    try {
      persist([...fetched.values()], new Date().toISOString());
    } catch (err) {
      logger.warn({ err }, 'Guard metadata: failed to persist video metadata');
    }
    for (const m of fetched.values()) {
      stored.set(m.videoId, {
        youtubeId: m.videoId,
        description: m.description,
        tags: m.tags,
        categoryId: m.categoryId,
        ageRestricted: m.ageRestricted,
        madeForKids: m.madeForKids,
      });
    }
  }
  return stored;
}
