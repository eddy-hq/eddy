# Eddy — Operations

Two machines: **M4 Mac Mini** (Tailscale: `mini-steve`) runs the Express server, Ollama, and Redis. **Ubuntu media server** (Tailscale: `mediaserver`) runs the download worker, ntfy, nginx, and Plex.

---

## Service map

| Service | Machine | Managed by |
|---|---|---|
| Express server (`src/index.ts`) | M4 | launchd `com.eddy.server` |
| Vite dev server | M4 | manual (`npm run dev:pwa`) |
| Redis | M4 | Homebrew (`brew services`, launchd `homebrew.mxcl.redis`) |
| Caddy (HTTPS for `eddyhq.app`) | M4 | launchd `com.steveu.edge.caddy` (LaunchDaemon, root) — config in `~/code/edge` |
| cloudflared | M4 | launchd `com.steveu.edge.cloudflared` — config in `~/code/edge` |
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

**Why launchd alone isn't enough for the Express server:** the plist runs `tsx watch --include 'src/**/*.ts' src/index.ts` (see `launchd/com.eddy.server.plist`) — watch mode reloads on source changes, and `KeepAlive` restarts on process exit if tsx itself dies. But if tsx ever hangs instead of exiting, launchd won't notice — the watchdog's `/health` probe catches that.

Two quirks worth knowing about the launchd setup:

- **`--include 'src/**/*.ts'`** is required. Without it, tsx's default import-graph watcher only fires on edits to the entry file (`src/index.ts`) when running under launchd — edits to imported modules are missed.
- **`CHOKIDAR_USEPOLLING=1`** is set in the plist's `EnvironmentVariables`. FSEvents is unreliable for daemonised processes on macOS; polling adds tiny CPU overhead but makes reloads deterministic.

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
   - `git pull --ff-only origin`
   - `npm ci` (full install, unconditional — the build needs dev deps like `tsc`/`vite`)
   - `npm run build` (`tsc && vite build && cp -r src/db/migrations dist/db/`) — the worker runs the compiled `dist/workers/download.js`, so the build is required
   - `systemctl --user restart eddy-worker`
   - Verifies worker is active before returning
3. Prints summary

**`--server` / `--full`** additionally runs `npm run build` **on the M4** (`tsc + vite build`, refreshing the `dist/pwa` the server serves), then `launchctl kickstart -k gui/$(id -u)/com.eddy.server` and waits for `/health` to respond. `--server-only` does the same M4 build + restart without touching Ubuntu.

The M4 Express server runs from source via `tsx watch` and hot-reloads on any change under `src/`, so server *logic* changes go live without a restart. A restart (`--server` / `--full`) is still needed to **apply new DB migrations** (they run on startup) or pick up new env vars; a **rebuild** is needed for **PWA changes**, since the server serves the prebuilt `dist/pwa` from disk. The `--server` / `--full` path does both. See also "Reloading the server plist" below for plist edits, which need a full bootout/bootstrap.

### Manually restarting services

```bash
# M4 — Express server
launchctl kickstart -k gui/$(id -u)/com.eddy.server

# M4 — Redis
brew services restart redis

# Ubuntu — worker
ssh -i ~/.ssh/id_ed25519_eddy steveu@mediaserver "systemctl --user restart eddy-worker"
```

### Reloading the server plist

The installed plist at `~/Library/LaunchAgents/com.eddy.server.plist` is a symlink to the repo copy, so edits to `launchd/com.eddy.server.plist` are live on disk. But launchd itself caches the loaded definition — a `kickstart` restarts the process with the old args. To pick up plist changes:

```bash
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.eddy.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eddy.server.plist
```

`ThrottleInterval` is 10s — if `bootstrap` silently fails to start the process, wait past that and it comes up, or run `launchctl kickstart gui/$(id -u)/com.eddy.server` to force it.

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

---

## Plex — Eddy Videos library prefs

Plex's per-library credit-marker detection (`enableCreditsMarkerGeneration`) runs ffmpeg analysis over every clip. Pointless on the Eddy Videos library — YouTube clips have no credits — and it pegs ~10 cores for hours per sweep. Disable it once on the mediaserver:

```bash
# Run from M4 with .env loaded, or substitute values by hand.
set -a; source .env; set +a
curl -s -X PUT \
  "${PLEX_URL}/library/sections/${PLEX_LIBRARY_SECTION_ID}/prefs?enableCreditsMarkerGeneration=0&X-Plex-Token=${PLEX_TOKEN}"
```

Verify:

```bash
curl -s "${PLEX_URL}/library/sections/${PLEX_LIBRARY_SECTION_ID}/prefs?X-Plex-Token=${PLEX_TOKEN}" \
  | grep -o 'id="enableCreditsMarkerGeneration"[^/]*value="[^"]*"'
```

Should report `value="false"`.

One-shot per Plex install — the pref persists across Plex restarts. Only re-run when rebuilding the mediaserver from scratch or recreating the Eddy Videos library. Leave Movies / TV libraries on Plex defaults; this URL targets section `${PLEX_LIBRARY_SECTION_ID}` only.

---

## HTTPS for the PWA — `eddyhq.app`

The PWA is served from `https://eddyhq.app/` with a real Let's Encrypt cert so iOS Safari treats it as a secure context (Web Share API, service workers, etc. require this). All traffic stays on the tailnet — the domain resolves publicly to the M4's Tailscale IP (`100.101.51.114`) via a DNS-only (grey-cloud) A record, so off-tailnet clients can't reach the service.

**Why direct TLS, not Cloudflare Tunnel:** the PWA's API calls return kid consumption data (titles, creators, watch times, guard verdicts). [ADR-0004](adr/0004-kids-consumption-never-leaves-m4.md) says that data must not transit a third party. CF Tunnel would terminate TLS at Cloudflare's edge, putting that data in plaintext on their infra. Direct TLS on the M4 keeps it on the tailnet end-to-end.

**Topology:**

```
browser on tailnet
   │ HTTPS (Let's Encrypt cert)
   ▼
Caddy :443  (LaunchDaemon, root, M4)
   │ HTTP, loopback
   ▼
Express :3737  (eddy server, M4, LaunchAgent)
```

Caddy lives in `~/code/edge` (separate repo). It also fronts the `urmston.org` CF Tunnel apps (pitchside, brain) — a single Caddy with two patterns. See `~/code/edge/README.md`.

### Media paths — same-origin proxy

`/videos/*` and `/thumbs/*` on `eddyhq.app` reverse-proxy to the Ubuntu mediaserver's nginx (canonical LAN URL: `http://<mediaserver-tailnet-ip>/videos|thumbs`). The page is HTTPS, so http:// media URLs would be blocked as mixed content; the proxy keeps everything same-origin. Bytes transit the M4 — acceptable for tailnet-only family use.

The DB still stores the LAN nginx URL on each row (canonical "where the file lives"). The API rewrites it to `https://eddyhq.app/...` at response-serialise time via `toPublicMediaUrl` in `src/modules/media`. Two env vars drive the rewrite:

```
PUBLIC_VIDEO_BASE_URL=https://eddyhq.app/videos
PUBLIC_THUMB_BASE_URL=https://eddyhq.app/thumbs
```

Unset them in dev to keep raw nginx URLs. To change the public scheme/host later, edit these two values — no DB migration.

### Cert renewal

Caddy renews Let's Encrypt certs automatically (90-day issuance, renewal attempted in the last 30 days). DNS-01 challenge against the `eddyhq.app` Cloudflare zone using `CF_DNS_TOKEN_EDDYHQ_APP` from `~/code/edge/.env`.

Renewal failures land in `~/data/edge/logs/caddy.err.log`. The watchdog doesn't currently check Caddy or surface renewal errors — TODO if a renewal silently fails in production.

### Verifying after a rebuild

From any tailnet client:

```
curl -vI https://eddyhq.app          # expect HTTP/2 200 with a valid LE cert
curl -vI https://www.eddyhq.app      # expect 301 → https://eddyhq.app
```

Off-tailnet (e.g. from a phone on cell data with Tailscale off):

```
nslookup eddyhq.app                   # resolves to 100.101.51.114
curl --max-time 5 https://eddyhq.app  # connection timeout — no public route
```

### Bouncing Caddy

```
sudo launchctl kickstart -k system/com.steveu.edge.caddy
tail -f ~/data/edge/logs/caddy.err.log
```

### Renewer trap

`brew upgrade caddy` does **not** update the running daemon. The LaunchDaemon points at `~/code/edge/bin/caddy`, a custom build that includes the Cloudflare DNS module (Homebrew Caddy doesn't). To refresh the daemon binary:

```
cd ~/code/edge && bin/build.sh && sudo launchctl kickstart -k system/com.steveu.edge.caddy
```

## API route prefixes

`src/api-prefixes.ts` is the single source of truth for top-level HTTP prefixes. Two consumers read it:

- **`src/server.ts`** — the SPA-fallback regex. Anything matching a prefix falls through to the router chain and reaches the JSON 404 handler on a miss; anything else returns `index.html` for client-side routing.
- **`vite.config.ts`** — the dev-server proxy map, so `npm run dev:pwa` on `:5173` forwards API calls to the Express server on `:3737`.

To add a new top-level route: add the prefix to the array, mount the router in `src/server.ts`. No changes needed in the Vite config or the fallback regex — both pick it up automatically.
