# Eddy — Operations

Two machines: **M4 Mac Mini** (Tailscale: `mini-steve`) runs the Express server, Ollama, and Redis. **Ubuntu media server** (Tailscale: `mediaserver`) runs the download worker, ntfy, nginx, and Plex.

---

## Service map

| Service | Machine | Managed by |
|---|---|---|
| Express server (`src/index.ts`) | M4 | launchd `com.eddy.server` |
| Vite dev server | M4 | manual (`npm run dev:pwa`) |
| Redis | M4 | Homebrew (`brew services`, launchd `homebrew.mxcl.redis`) |
| Download worker (`dist/workers/download.js`) | Ubuntu | systemd `eddy-worker` |
| ntfy | Ubuntu | Docker (`eddy-ntfy` container) |
| nginx | Ubuntu | system service |
| Plex | Ubuntu | system service |

---

## Watchdog (`scripts/watchdog.sh`)

Runs every 60 seconds via launchd (`launchd/com.eddy.watchdog.plist`). Self-healing — no manual intervention needed for transient failures.

**What it checks and fixes:**

1. **M4 Express server** — curls `http://localhost:3737/health`. If unreachable, runs `launchctl kickstart -k gui/$(id -u)/com.eddy.server` and rechecks. launchd's `KeepAlive` is the primary recovery path; the watchdog is defence-in-depth and the notification path.
2. **Tailscale** — if state is not `Running`, runs `tailscale up`. If state is `NeedsLogin`, notifies and aborts (can't auto-fix).
3. **SSH to Ubuntu** — if unreachable despite Tailscale being up, notifies. All remote checks are skipped.
4. **eddy-worker** — checks `systemctl --user is-active eddy-worker`. If not active, restarts it and rechecks.

Sends an ntfy notification to Steve's topic on any corrective action or unrecoverable failure.

**Log:** `logs/watchdog.log`

**Not in this script:**
- **Redis** — launchd's `KeepAlive: true` on `homebrew.mxcl.redis` handles it natively.

**Why launchd alone isn't enough for the Express server:** the plist runs `tsx src/index.ts` (no `watch` — see `launchd/com.eddy.server.plist`). `KeepAlive` restarts on process exit, which is fine for crashes. But if tsx ever hangs instead of exiting, launchd won't notice — the watchdog's `/health` probe catches that.

### Loading / reloading the watchdog

```bash
# First time
cp launchd/com.eddy.watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eddy.watchdog.plist

# Force an immediate run (e.g. after editing the script)
launchctl kickstart gui/$(id -u)/com.eddy.watchdog

# Check it's registered
launchctl list | grep eddy
```

---

## Deploy (`scripts/deploy.sh`)

Single command to push code and update the Ubuntu worker. Available as npm scripts.

```bash
npm run deploy            # push + update Ubuntu worker
npm run deploy:full       # push + Ubuntu worker + restart M4 server
npm run deploy -- --server-only   # restart M4 server only
```

**What `npm run deploy` does:**

1. `git push origin <current-branch>`
2. SSHes to Ubuntu:
   - `git pull --ff-only`
   - `npm ci --omit=dev` — only if `package.json` or `package-lock.json` changed since Ubuntu's last commit; skipped otherwise
   - `npm run build` (`tsc && vite build && copy migrations`)
   - `systemctl --user restart eddy-worker`
   - Verifies worker is active before returning
3. Prints summary

**`--server` / `--full`** additionally runs `launchctl kickstart -k gui/$(id -u)/com.eddy.server` and waits for `/health` to respond.

The M4 Express server uses `tsx watch` and hot-reloads most source changes automatically — a server restart is only needed when picking up new env vars or after a crash.

### Manually restarting services

```bash
# M4 — Express server
launchctl kickstart -k gui/$(id -u)/com.eddy.server

# M4 — Redis
brew services restart redis

# Ubuntu — worker
ssh -i ~/.ssh/id_ed25519_eddy steveu@mediaserver "systemctl --user restart eddy-worker"
```

### Checking service state

```bash
npm run health            # full health check across both machines
tail -f logs/watchdog.log # live watchdog activity
launchctl list | grep eddy
```

---

## Ubuntu worker — systemd details

Service file: `systemd/eddy-worker.service`, installed at `~/.config/systemd/user/` on Ubuntu. Linger is enabled — starts at boot and persists after SSH logout.

After deploying code changes to Ubuntu manually (outside of `deploy.sh`):

```bash
npm run build             # on Ubuntu
systemctl --user restart eddy-worker
```

**Reboot failure mode:** if the M4 reboots mid-download, yt-dlp finishes but the HMAC callback fails. BullMQ retries the whole job. `downloadVideo()` is idempotent — if the file already exists it skips yt-dlp and goes straight to the callback. If jobs are stuck in `downloading` status after a reboot: check worker state, check if file is on disk, check BullMQ failed set.
