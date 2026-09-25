import { Router, Request, Response } from 'express';
import { NotFoundError, ValidationError } from '../../errors';
import { logger } from '../../logger';
import { resolveUserById } from '../users';
import { readMessage } from './messages';

export const notificationsRouter = Router();

// GET /notifications/:messageId — what the Notification Service Extension calls
// to turn an opaque push into real content. Tailnet-only, authenticated as the
// device's own user: a message is readable only by its recipient, and someone
// else's message is a 404, not a 403 — the caller learns nothing either way.
//
// The extension has a few seconds before iOS gives up on it, so the response is
// three fields and no lookups beyond the one row.
//
// Every fetch logs one line — the opaque message id and the outcome, never the
// content or who it was for — so pushes accepted by APNs can be matched against
// fetches, and a missing fetch means the phone showed the placeholder.
notificationsRouter.get('/:messageId', (req: Request, res: Response) => {
  const messageId = req.params['messageId'];
  const { userId } = req.query as { userId?: unknown };

  let user;
  try {
    user = resolveUserById(userId);
  } catch (err) {
    logger.info({ messageId, outcome: 'user_rejected' }, 'Notification message fetch');
    throw err;
  }

  if (!messageId) throw new ValidationError('messageId required');

  const content = readMessage(messageId, user.user_id);
  logger.info({ messageId, outcome: content ? 'found' : 'not_found' }, 'Notification message fetch');
  if (!content) throw new NotFoundError('message');

  res.status(200).json(content);
});
