import { Router, Request, Response } from 'express';
import { NotFoundError, ValidationError } from '../../errors';
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
notificationsRouter.get('/:messageId', (req: Request, res: Response) => {
  const { userId } = req.query as { userId?: unknown };
  const user = resolveUserById(userId);

  const messageId = req.params['messageId'];
  if (!messageId) throw new ValidationError('messageId required');

  const content = readMessage(messageId, user.user_id);
  if (!content) throw new NotFoundError('message');

  res.status(200).json(content);
});
