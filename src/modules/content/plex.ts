import { config } from '../../config';
import { logger } from '../../logger';

// Triggers a Plex library refresh for the Eddy videos section.
// Best-effort — logs a warning on failure but does not throw.
export async function triggerPlexScan(): Promise<void> {
  const plexUrl = config.PLEX_URL;
  const plexToken = config.PLEX_TOKEN;
  const sectionId = config.PLEX_LIBRARY_SECTION_ID;

  if (!plexUrl || !plexToken || !sectionId) {
    logger.warn('Plex not configured — skipping scan trigger');
    return;
  }

  const url = `${plexUrl}/library/sections/${sectionId}/refresh?X-Plex-Token=${plexToken}`;

  try {
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'Plex scan trigger returned non-OK status');
    } else {
      logger.info({ sectionId }, 'Plex scan triggered');
    }
  } catch (err) {
    logger.warn({ err }, 'Plex scan trigger failed (non-fatal)');
  }
}

interface PlexPart { file?: string }
interface PlexMedia { Part?: PlexPart[] }
interface PlexMetadataItem { ratingKey?: string; Media?: PlexMedia[] }
interface PlexAllResponse { MediaContainer?: { Metadata?: PlexMetadataItem[] } }

async function findRatingKeyByFile(filePath: string): Promise<string | null> {
  const url = `${config.PLEX_URL}/library/sections/${config.PLEX_LIBRARY_SECTION_ID}/all?X-Plex-Token=${config.PLEX_TOKEN}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as PlexAllResponse;
  const items = data.MediaContainer?.Metadata ?? [];
  for (const item of items) {
    for (const media of item.Media ?? []) {
      for (const part of media.Part ?? []) {
        if (part.file === filePath && item.ratingKey) return item.ratingKey;
      }
    }
  }
  return null;
}

// Plex indexes a new file a beat or two after the scan trigger fires, so the
// initial query usually misses. Poll with a short interval until the deadline.
async function waitForRatingKey(filePath: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const ratingKey = await findRatingKeyByFile(filePath);
    if (ratingKey) return ratingKey;
    if (Date.now() + 1000 >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  logger.debug({ filePath, attempts: attempt }, 'Plex item not found within timeout');
  return null;
}

async function putItemMetadata(ratingKey: string, title: string, summary: string): Promise<void> {
  const params = new URLSearchParams({
    type: '1',
    id: ratingKey,
    'title.value': title,
    'title.locked': '1',
    'summary.value': summary,
    'summary.locked': '1',
    'X-Plex-Token': config.PLEX_TOKEN!,
  });
  const url = `${config.PLEX_URL}/library/sections/${config.PLEX_LIBRARY_SECTION_ID}/all?${params.toString()}`;
  const resp = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Plex metadata PUT returned ${resp.status}`);
}

async function postItemPoster(ratingKey: string, posterUrl: string): Promise<void> {
  const params = new URLSearchParams({ url: posterUrl, 'X-Plex-Token': config.PLEX_TOKEN! });
  const url = `${config.PLEX_URL}/library/metadata/${ratingKey}/posters?${params.toString()}`;
  const resp = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Plex poster POST returned ${resp.status}`);
}

export interface PlexMetadataUpdate {
  filePath: string;
  title: string;
  summary: string;
  posterUrl: string | null;
}

// Best-effort: polls for the indexed item, then sets title/summary and poster.
// Returns false on any failure (including timeout) so callers can decide whether
// to log additional context. Never throws.
export async function updatePlexMetadata(
  update: PlexMetadataUpdate,
  options: { waitMs?: number } = {},
): Promise<boolean> {
  if (!config.PLEX_URL || !config.PLEX_TOKEN || !config.PLEX_LIBRARY_SECTION_ID) {
    logger.warn('Plex not configured — skipping metadata update');
    return false;
  }

  const ratingKey = await waitForRatingKey(update.filePath, options.waitMs ?? 15_000);
  if (!ratingKey) {
    logger.warn({ filePath: update.filePath }, 'Plex did not index file in time — metadata not set');
    return false;
  }

  try {
    await putItemMetadata(ratingKey, update.title, update.summary);
    if (update.posterUrl) await postItemPoster(ratingKey, update.posterUrl);
    logger.info({ ratingKey, filePath: update.filePath }, 'Plex metadata updated');
    return true;
  } catch (err) {
    logger.warn({ err, ratingKey, filePath: update.filePath }, 'Plex metadata update failed (non-fatal)');
    return false;
  }
}
