# AGENTS.md

Self-hosted family media system.

**Read first:**
- **`docs/brief.md`** — full product spec
- **`docs/ops.md`** — service map, watchdog, deploy script, restart commands (read before touching infrastructure)

**Read when relevant:**
- **`CONTEXT.md`** — domain glossary; canonical terms and aliases to avoid
- **`docs/adr/`** — load-bearing decisions (architecture, data model, notification channel, privacy boundary)
- **`docs/design-notes.md`** — prose design rationale below the ADR threshold

## Data location

`eddy.db`, `eddy.db-shm`, `eddy.db-wal` live at `~/data/eddy/` — outside the repo. `.env`'s `DATABASE_PATH` is the absolute path; `src/db/client.ts` reads it via `config.DATABASE_PATH`. Don't reintroduce `./eddy.db` defaults.

## Workflow

- Confirm current phase with Steve before coding. Phases are sequential (Section 17 of brief).
- Don't build ahead. Don't refactor outside current phase.
- If spec and reality disagree: stop, surface in chat, get a decision.
- Leave the system runnable and committable at session end.

## Non-negotiables

- **Kid safety:** default to escalation in the guard. Never auto-approve uncertain content. Never silently fail — every reject has a reason and appeal path.
- **Privacy:** kids' consumption data never leaves the M4. MCP responses substitute `kid_1`, `kid_2`. Privacy filter on every MCP response — test it.
- **The five rules in Section 1 of the brief are constraints, not aspirations.**

## Decisions already made — don't relitigate

Quick reference; durable form in `docs/adr/`.

- Modular monolith. Two Node entry points (M4 server, Ubuntu worker) sharing modules. Modules are TS files, not services.
- yt-dlp directly (no Tube Archivist). Eddy owns video files; Plex/nginx read.
- ntfy self-hosted is the only notification channel. No Web Push, Pushover, email, SMS.
- SQLite single-file. `better-sqlite3`.
- Gemma 4 E4B for guard triage. No frontier API calls until Phase 11 (optional).
- No Tailwind, no CSS-in-JS, no Storybook in the PWA.
- Signed-token pattern for every notification action endpoint.

## Stack

TypeScript strict · Node LTS · Express · SQLite (`better-sqlite3`) · BullMQ + Redis · Ollama (`gemma4:e4b`) · ntfy · React 19 + Vite · Framer Motion · Zustand · TanStack Query · Lucide.

No Python in Eddy — yt-dlp is a binary shell-out.

## Conventions

- **No PII in commit messages, code comments, or log strings.** Kids are Boy1 / Boy2. No real names, IDs, IPs, or tokens in anything that goes to git.
- All config via `.env`, validated with zod on startup. Update `.env.example` when adding vars.
- Errors: typed classes, throw don't return tuples.
- Logging: structured (pino) in server/worker code. CLI scripts under `src/scripts/` may use `console.log` for terminal output.
- Time: ISO 8601 or Unix timestamps in DB. Never local time.
- IDs: UUID v7. YouTube IDs as PK for video tables.
- Module boundaries: import only from `index.ts`. No reaching into internals.
- DB access only via `src/db/client.ts`. DB calls live inside the owning module, not in shared helpers.
- Tests (Vitest) for: guard verdicts, override expiry, deletion logic, MCP privacy filter, signed-token validation. Skip trivial.
- **BullMQ custom job IDs:** must contain 0 colons or exactly 2 (the repeatable-job `name:id:type` form). A single colon throws synchronously inside BullMQ and is only caught at `warn` level — the job never lands in Redis. Use `-` as separator for new job types (e.g. `delete-${id}`).

## Push back if asked to

- Add a notification channel other than ntfy.
- Make a frontier API call from runtime code (Phase 11 only, and only if enabled).
- Split modules into HTTP services.
- Put persistent user state in `localStorage` / `sessionStorage` in the PWA. Transient UI-only state (e.g. video resume position) is fine.
- Add Tailwind, Storybook, or CSS-in-JS.
- Auto-apply Drift suggestions or any profile change.
- Put kid PII or consumption details in anything that could leave the local network.

## Deploying / restarting

Always use `npm run deploy` — never raw `launchctl` or `systemctl`. Migrations run on server startup; applying a new migration requires `npm run deploy -- --server` (or `npm run deploy:full`) to restart the M4 server.

## Verify before declaring done

```
npm run typecheck
npm run lint
npm run test
```

All green. New behaviour demonstrable end-to-end on the M4 over Tailscale.