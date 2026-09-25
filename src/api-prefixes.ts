// Single source of truth for Eddy's HTTP API prefixes.
// Imported by server.ts (mount + SPA-fallback regex) and vite.config.ts
// (dev proxy). Keep free of runtime imports so vite can load it at config time.

export const API_PREFIXES = [
  '/requests',
  '/internal',
  '/people',
  '/search',
  '/interests',
  '/avatars',
  '/discovery',
  '/watch-events',
  '/devices',
  '/notifications',
  '/parent',
  '/health',
  '/action',
  '/ios',
  '/site',
] as const;
