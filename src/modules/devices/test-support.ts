import type { NextFunction, Request, Response } from 'express';
import { resolveUserByIdOrName } from '../users';
import { bindActor } from './credential';

// Tests only. Router-level tests mount one router without the credential gate;
// this stands in for `requireDevice` by trusting the request's own `userId` —
// exactly what production no longer does (ADR-0016), which is why it lives
// here and is not exported from the module's barrel. The gate itself is tested
// in devices.test.ts.
export function actAsClaimedUser(req: Request, _res: Response, next: NextFunction): void {
  const query = req.query as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const claim = query['userId'] ?? body['userId'] ?? query['user'] ?? body['user'];
  if (typeof claim === 'string' && claim) {
    try {
      bindActor(req, resolveUserByIdOrName(claim), 'test-device');
    } catch (err) {
      next(err);
      return;
    }
  }
  next();
}
