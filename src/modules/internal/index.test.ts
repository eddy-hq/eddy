import express, { type Request as ExpressRequest } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Every /internal route is worker traffic and must verify the HMAC signature.
// A route without it is reachable by any device on the LAN or tailnet, so this
// walks the router and refuses any route that answers an unsigned request.

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  return { db: new Database(':memory:') };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: {
    INTERNAL_HMAC_SECRET: 'test-secret',
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

vi.mock('../../queue', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), del: vi.fn(), set: vi.fn() },
  downloadQueue: { getJob: vi.fn(), add: vi.fn() },
  deleteQueue: { add: vi.fn() },
  guardQueue: { add: vi.fn() },
  discoveryQueue: {},
  thumbsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: vi.fn().mockResolvedValue(undefined) }),
  parseRelayPayload: vi.fn(),
}));

import { internalRouter } from './index';

const app = express();
app.use(express.json({
  verify: (req: ExpressRequest & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use('/internal', internalRouter);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

function registeredRoutes(): Array<{ method: Method; path: string }> {
  const routes: Array<{ method: Method; path: string }> = [];
  for (const layer of internalRouter.stack as RouteLayer[]) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) routes.push({ method: method as Method, path: layer.route.path });
    }
  }
  return routes;
}

// Express params (`:id`, `:youtube_id`) filled with a placeholder value.
function concrete(path: string): string {
  return `/internal${path.replace(/:[A-Za-z_]+/g, 'placeholder')}`;
}

describe('internal router', () => {
  const routes = registeredRoutes();

  it('has routes to check', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)('$method $path refuses an unsigned request', async ({ method, path }) => {
    const res = await supertest(app)[method](concrete(path))
      .set('content-type', 'application/json')
      .send(JSON.stringify({ requestId: 'placeholder' }));
    expect(res.status).toBe(401);
  });

  it.each([
    ['get', '/internal/health/queue'],
    ['post', '/internal/requests/placeholder/retry'],
    ['get', '/internal/backfill/pending-thumbs'],
    ['post', '/internal/watchdog/run'],
  ] as const)('%s %s is gone', async (method, path) => {
    const res = await supertest(app)[method](path);
    expect(res.status).toBe(404);
  });
});
