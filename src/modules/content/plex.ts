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
