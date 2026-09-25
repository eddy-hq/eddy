import { Router, Request, Response } from 'express';

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
