# Ubuntu moves bytes, M4 thinks

Two physical machines were available — an M4 Mac mini on WiFi and a 2012 Mac mini on Ethernet next to the router — and the obvious shape was two HTTP services with a contract between them. Instead, Eddy is one codebase with two Node entry points sharing TypeScript modules, one SQLite file owned by the M4, and a single cross-process boundary: the BullMQ queue (Redis on Ubuntu) plus one HMAC-authed callback `POST /internal/videos/:id/downloaded`. Ubuntu never writes SQLite directly.

The split is dictated by the hardware, not by service boundaries. Anything shifting large payloads runs on Ubuntu (Ethernet, SSD, ffmpeg). Anything reasoning or serving small responses runs on the M4 (GPU for Gemma, owns the DB and the PWA). Video doesn't cross WiFi twice; Gemma doesn't compete with ffmpeg for memory. A two-service shape would have added contract versioning, separate deploys, and either duplicated modules or a third shared-library package — costs that don't earn their place at household scale on two boxes I own.

## Consequences

- New cross-process behaviour means a new BullMQ job or (rarely) a new HMAC callback, not a new HTTP endpoint.
- The "modules import only from `index.ts`" rule (CLAUDE.md) is what keeps the monolith from rotting into a tangle — if module boundaries quietly dissolve, this ADR's cost/benefit flips.
