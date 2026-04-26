import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { downloadQueue } from '../../queue';
import { ValidationError, NotFoundError } from '../../errors';
import type { DownloadJobData } from '../content';
import { resolveUserById } from '../users';
import { freshnessMultiplier, rankWeight } from './ranker';

export const discoveryRouter = Router();

// GET /discovery/preview-html?user=<name|id>
// Visual dry-run of surfacing logic, served to the local network so it's
// reachable from any device over Tailscale without copying files around.
discoveryRouter.get('/preview-html', async (req: Request, res: Response) => {
  // Dynamic import keeps preview.ts lazy and avoids circular-dep issues at
  // module init time (preview.ts imports helpers from this module).
  const { renderPreviewHtml } = await import('./preview');
  const target = typeof req.query['user'] === 'string' ? req.query['user'] : null;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderPreviewHtml(target));
});

interface SurfacedCandidateRow {
  candidate_id: string;
  url: string;
  external_id: string | null;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  gemma_score: number | null;
  connection_score: number | null;
  quality_score: number | null;
  time_sensitivity: string | null;
  why_text: string | null;
  interest_id: string | null;
  source_type: string;
  rank: number;
}

// GET /discovery/feed?userId=
discoveryRouter.get('/feed', (req: Request, res: Response) => {
  const user = resolveUserById(req.query['userId']);
  const today = new Date().toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT c.candidate_id, c.url, c.external_id, c.title, c.thumbnail_url, c.published_at,
           c.gemma_score, c.connection_score, c.quality_score, c.time_sensitivity,
           c.why_text, c.interest_id, c.source_type,
           COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    WHERE c.user_id = ? AND c.surfaced_date = ? AND c.status = 'surfaced'
  `).all(user.user_id, today) as SurfacedCandidateRow[];

  const now = new Date();
  const candidates = rows
    .map((r) => ({
      row: r,
      weighted: (r.connection_score ?? 0)
        * (r.quality_score ?? 0)
        * freshnessMultiplier(r.published_at, r.time_sensitivity, now)
        * rankWeight(r.rank),
    }))
    .sort((a, b) => b.weighted - a.weighted)
    .map((x) => x.row);

  const interestCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM user_interests WHERE user_id = ?'
  ).get(user.user_id) as { n: number }).n;

  const coldStart = interestCount === 0 || candidates.length === 0;

  // Balance prompt: dominant interest >70% of today's feed AND no prompt shown in past 10 days
  let balancePrompt: {
    promptId: string;
    interestId: string;
    interestLabel: string;
    concentration: number;
  } | null = null;

  if (candidates.length >= 3) {
    const interestCounts = new Map<string, number>();
    for (const c of candidates) {
      if (c.interest_id) interestCounts.set(c.interest_id, (interestCounts.get(c.interest_id) ?? 0) + 1);
    }
    const [topInterestId, topCount] = [...interestCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];

    if (topInterestId && topCount / candidates.length > 0.7) {
      const concentration = topCount / candidates.length;
      const recentPrompt = db.prepare(`
        SELECT 1 FROM balance_prompts
        WHERE user_id = ? AND interest_id = ? AND shown_at > datetime('now', '-10 days')
        LIMIT 1
      `).get(user.user_id, topInterestId);

      if (!recentPrompt) {
        const interestRow = db.prepare('SELECT label FROM interests WHERE id = ?')
          .get(topInterestId) as { label: string } | undefined;
        const promptId = uuidv7();
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO balance_prompts (prompt_id, user_id, interest_id, interest_label, concentration, shown_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(promptId, user.user_id, topInterestId, interestRow?.label ?? topInterestId, concentration, now);
        balancePrompt = { promptId, interestId: topInterestId, interestLabel: interestRow?.label ?? topInterestId, concentration };
      }
    }
  }

  res.json({
    candidates: candidates.map((c) => ({
      candidateId: c.candidate_id,
      url: c.url,
      externalId: c.external_id,
      title: c.title,
      thumbnailUrl: c.thumbnail_url,
      publishedAt: c.published_at,
      score: c.gemma_score,
      why: c.why_text,
      interestId: c.interest_id,
      sourceType: c.source_type,
    })),
    coldStart,
    balancePrompt,
  });
});

// POST /discovery/dismiss — body: { userId, candidateId }
discoveryRouter.post('/dismiss', (req: Request, res: Response) => {
  const { userId, candidateId } = req.body as { userId?: string; candidateId?: string };
  const user = resolveUserById(userId);
  if (!candidateId?.trim()) throw new ValidationError('candidateId required');

  const candidate = db.prepare(
    'SELECT candidate_id FROM candidate_pool WHERE candidate_id = ? AND user_id = ?'
  ).get(candidateId, user.user_id) as { candidate_id: string } | undefined;
  if (!candidate) throw new NotFoundError(`candidate ${candidateId}`);

  db.prepare(`UPDATE candidate_pool SET status = 'dismissed' WHERE candidate_id = ?`).run(candidateId);

  res.json({ candidateId, status: 'dismissed' });
});

// POST /discovery/request — body: { userId, candidateId }
discoveryRouter.post('/request', async (req: Request, res: Response) => {
  const { userId, candidateId } = req.body as { userId?: string; candidateId?: string };
  const user = resolveUserById(userId);
  if (!candidateId?.trim()) throw new ValidationError('candidateId required');

  const candidate = db.prepare(
    'SELECT candidate_id, url, external_id, title FROM candidate_pool WHERE candidate_id = ? AND user_id = ?'
  ).get(candidateId, user.user_id) as {
    candidate_id: string;
    url: string;
    external_id: string | null;
    title: string | null;
  } | undefined;
  if (!candidate) throw new NotFoundError(`candidate ${candidateId}`);

  const requestId = uuidv7();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, title, status, decided_by, decided_at, requested_at)
    VALUES
      (?, ?, 'recommended', ?, ?, ?, 'downloading', 'auto', ?, ?)
  `).run(requestId, user.user_id, candidate.url, candidate.external_id, candidate.title, now, now);

  const jobData: DownloadJobData = { requestId, youtubeId: candidate.external_id ?? '', url: candidate.url };
  await downloadQueue.add('download', jobData, { jobId: requestId });

  db.prepare(`UPDATE candidate_pool SET status = 'requested' WHERE candidate_id = ?`).run(candidateId);

  logger.info({ requestId, candidateId, userId: user.user_id }, 'Discovery: candidate requested');

  res.status(202).json({ requestId, candidateId, status: 'downloading' });
});
