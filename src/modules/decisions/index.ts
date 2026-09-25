// Decisions (Phase 6a): the parent surface for Escalations and Spot checks.
// Every route is parent-only — the caller passes a parent's user id (UUID,
// not display name), and a kid's id is refused. Same network posture as the
// other PWA routes (LAN / Tailscale); there is no separate parent login.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { recordDecision, requireParent, type DecisionOutcome } from './decide';
import { readDecisionQueue } from './queue';

export { readDecisionQueue, type DecisionQueue, type DecisionCard, type CardSubject } from './queue';
export { recordDecision, requireParent, type DecisionOutcome, type DecisionEffect } from './decide';

export const decisionsRouter = Router();

const queueQuery = z.object({
  userId: z.string().min(1),
  mode: z.enum(['today', 'catch_up']).default('today'),
  focus: z.enum(['escalations', 'spot_checks']).optional(),
});

const decideBody = z.object({
  userId: z.string().min(1),
  decisions: z.array(z.object({
    subjectType: z.enum(['candidate', 'request']),
    subjectId: z.string().min(1),
    verdict: z.enum(['clear_yes', 'clear_no']),
  })).min(1).max(4),
});

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const out = schema.safeParse(value);
  if (!out.success) throw new ValidationError(out.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return out.data;
}

// GET /parent/decisions/queue?userId=<parent>&mode=today|catch_up&focus=escalations|spot_checks
decisionsRouter.get('/queue', (req: Request, res: Response) => {
  const q = parse(queueQuery, req.query);
  requireParent(q.userId);
  res.json(readDecisionQueue({ mode: q.mode, focus: q.focus }));
});

// POST /parent/decisions { userId, decisions: [{ subjectType, subjectId, verdict }] }
// One card's decisions: one subject, or one per kid for "same for both".
decisionsRouter.post('/', async (req: Request, res: Response) => {
  const body = parse(decideBody, req.body);
  const parentId = requireParent(body.userId);
  const outcomes: DecisionOutcome[] = [];
  for (const d of body.decisions) {
    outcomes.push(await recordDecision(parentId, d));
  }
  res.json({ outcomes });
});
