import { Router, Request, Response } from 'express';
import { actorOf } from '../devices';
import { getAvatar, saveAvatar } from './store';
import { coerceAvatarConfig } from './types';

export const avatarsRouter = Router();

// The avatar is the device owner's (ADR-0016). A `userId` in the request is
// checked against the credential before it gets here, and not read.

avatarsRouter.get('/', (req: Request, res: Response) => {
  res.json({ avatar: getAvatar(actorOf(req).user_id) });
});

avatarsRouter.put('/', (req: Request, res: Response) => {
  const body = req.body as { avatar?: unknown };
  // Coerce rather than reject — any unknown field falls back to the default,
  // so a slightly-stale client (older enum) still gets a clean save.
  const next = coerceAvatarConfig(body.avatar);
  res.json({ avatar: saveAvatar(actorOf(req).user_id, next) });
});
