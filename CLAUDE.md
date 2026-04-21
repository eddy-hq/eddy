# CLAUDE.md

Self-hosted family media system. Full spec: **`docs/brief.md`** — read it.

**Operations** (service map, watchdog, deploy script, manual restart commands): **`docs/ops.md`** — read before touching infrastructure or asking how to restart things.

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

- Modular monolith. One Node process. Modules are TS files, not services.
- yt-dlp directly (no Tube Archivist). Eddy owns video files; Plex/nginx read.
- ntfy self-hosted is the only notification channel. No Web Push, Pushover, email, SMS.
- SQLite single-file. `better-sqlite3`.
- Gemma 4 E4B for guard triage. No frontier API calls until Phase 8.
- No Tailwind, no CSS-in-JS, no Storybook in the PWA.
- Signed-token pattern for every notification action endpoint.

## Stack

TypeScript strict · Node LTS · Express · SQLite (`better-sqlite3`) · BullMQ + Redis · Ollama (`gemma4:e4b`) · ntfy · React 18 + Vite · Framer Motion · Zustand · TanStack Query · Lucide · Radix.

No Python in Eddy — yt-dlp is a binary shell-out.

## Conventions

- **No PII in commit messages, code comments, or log strings.** Kids are Boy1 / Boy2. No real names, IDs, IPs, or tokens in anything that goes to git.
- All config via `.env`, validated with zod on startup. Update `.env.example` when adding vars.
- Errors: typed classes, throw don't return tuples.
- Logging: structured (pino). No `console.log` in committed code.
- Time: ISO 8601 or Unix timestamps in DB. Never local time.
- IDs: UUID v7. YouTube IDs as PK for video tables.
- Module boundaries: import only from `index.ts`. No reaching into internals.
- DB access only via `src/db/client.ts`. Repository functions per module.
- Tests (Vitest) for: guard verdicts, override expiry, deletion logic, MCP privacy filter, signed-token validation. Skip trivial.

## Push back if asked to

- Add a notification channel other than ntfy.
- Make a frontier API call from runtime code (Phase 8 only, conditionally).
- Split modules into HTTP services.
- Use `localStorage` / `sessionStorage` in the PWA.
- Add Tailwind, Storybook, or CSS-in-JS.
- Auto-apply Drift suggestions or any profile change.
- Put kid PII or consumption details in anything that could leave the local network.

## Deploying / restarting

Always use `npm run deploy` — never raw `launchctl` or `systemctl`. Migrations run on server startup; applying a new migration requires `npm run deploy --server` (or `--full`) to restart the M4 server.

## Verify before declaring done

```
npm run typecheck
npm run lint
npm run test
```

All green. New behaviour demonstrable end-to-end on the M4 over Tailscale.