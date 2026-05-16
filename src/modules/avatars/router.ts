import { Router, Request, Response } from 'express';
import { resolveUserById } from '../users';
import { getAvatar, saveAvatar } from './store';
import { coerceAvatarConfig } from './types';

export const avatarsRouter = Router();

avatarsRouter.get('/', (req: Request, res: Response) => {
  const user = resolveUserById(req.query['userId']);
  res.json({ avatar: getAvatar(user.user_id) });
});

avatarsRouter.put('/', (req: Request, res: Response) => {
  const body = req.body as { userId?: string; avatar?: unknown };
  const user = resolveUserById(body.userId);
  // Coerce rather than reject — any unknown field falls back to the default,
  // so a slightly-stale client (older enum) still gets a clean save.
  const next = coerceAvatarConfig(body.avatar);
  res.json({ avatar: saveAvatar(user.user_id, next) });
});
