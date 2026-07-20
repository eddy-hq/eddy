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

## yt-dlp version channel & the PO-token stack

YouTube's "Sign in to confirm you're not a bot" detection is an arms race. Fixes land in yt-dlp's **nightly** channel first and only periodically roll into stable, so **the download worker tracks nightly, not stable.** Stable can lag 2+ months on exactly the extractor code that fights bot-detection.

**Ubuntu worker** (`config.YTDLP_BIN` = `~/.local/bin/yt-dlp`, pip `--user`) — pinned to nightly on 2026-05-31. To upgrade:

```bash
# on Ubuntu
python3 -m pip install -U --pre --user --break-system-packages "yt-dlp[default]"
~/.local/bin/yt-dlp --version   # expect a nightly stamp like 2026.05.25.234532
```

No worker restart needed — yt-dlp is shelled out per job, so the next download uses the new binary.

**Footgun:** `pip install yt-dlp` *without* `--pre` silently reverts to stable. Always include `--pre`.

**PO-token stack** (clears bot-detection without cookies, on the worker): the `bgutil-ytdlp-pot-provider` pip plugin + the `bgutil-pot-server.service` Node server on `127.0.0.1:4416`. Plugin and server must stay version-matched (both 1.3.1 as of 2026-05-31). The worker passes `--extractor-args youtube:player_client=mweb` + the POT plugin via `baseArgs()` in `src/modules/content/download.ts`; the M4 **search** path (`src/ytdlp.ts`) is deliberately anonymous and gets none of this.

**M4** runs yt-dlp for anonymous metadata *search* only — it does **not** download. (When `DISCOVERY_SOURCE=api`, metadata comes from the YouTube Data API instead and the M4's yt-dlp goes idle except as the fallback — see *Discovery metadata source* below.) Pinned to nightly on 2026-05-31 to match the worker, via a standalone universal build at `~/.local/bin/yt-dlp` (Homebrew's build blocks self-update, so brew can't follow nightly). `config.YTDLP_BIN_M4` points there explicitly because launchd's PATH wouldn't include `~/.local/bin`. To upgrade:

```bash
~/.local/bin/yt-dlp --update-to nightly
~/.local/bin/yt-dlp --version   # expect a nightly stamp like 2026.05.25.234532
```

Binary self-updates need no server restart (shelled out per call), but the one-time switch off Homebrew was a `YTDLP_BIN_M4` path change in `.env`, which did need `npm run deploy -- --server`. Homebrew stable at `/opt/homebrew/bin/yt-dlp` remains the `config.YTDLP_BIN_M4` default/fallback.

**Nightly is not a free pass:** bot-blocks are also volume-triggered and IP-wide (both boxes share one household public IP). Nightly raises the threshold; it doesn't make throughput unlimited. If a block hits, stop retrying and let the IP go quiet — see the watchdog note below, and don't let stuck `downloading` rows re-enqueue into a blocked IP.

### Throughput throttling (issue #185)

Eddy now rate-shapes its own yt-dlp throughput so it stops *causing* the volume blocks, and stands down automatically when one hits. All knobs are `.env` (zod-validated, see `.env.example`):

- **`YTDLP_BOTDETECT_COOLDOWN_SECS`** (default 2700 = 45 min) — on a bot-detection signature, the detector (`src/botdetect.ts`) arms a cooldown via a Redis key (`eddy:ytdlp:botdetect-cooldown`). It's **cross-process**: the Ubuntu download worker and the M4 discovery search both check and arm it, because the block is IP-wide. While armed, the worker **parks** queued downloads in BullMQ's `delayed` state (`moveToDelayed`, which doesn't spend a retry) instead of hammering, and discovery **skips** its interest-search + back-catalogue fan-out. Set `0` to disable.
- **`DISCOVERY_SEARCH_LIMIT`** (default 10, was a hardcoded 20) — `ytsearchN` depth for the interest search. Halving it halves the per-search extraction volume.
- **`DISCOVERY_SEARCH_DELAY_MS` / `DISCOVERY_SEARCH_JITTER_MS`** (default 2000 / 2000) — base + random gap between consecutive searches so a user's fan-out drips.
- **`DISCOVERY_HOUR_STEVE` / `_BOY2` / `_BOY1`** (default 6 / 10 / 14) and **`DISCOVERY_HOUR_DEFAULT`** (default 6) — per-user discovery hour (local, 0–23). This replaced the old `DISCOVERY_USER_STAGGER_MS` intra-run gap: instead of one 06:00 job that loops the fleet, each user now has its **own repeatable cron** at its hour (`discovery-user-<uuid>`), so search + download volume spreads across the day rather than spiking at once. Spreading is the real lever against a *volume*-triggered, IP-wide block; seconds of intra-run stagger were cosmetic. The schedule is **reconciled on every startup** (`reconcileDiscoverySchedule` drops all existing repeatables and re-adds the current set), so changing an hour just needs a server restart. Users fire at `hour:10`.
- **RSS poll** (`discovery-rss-poll`, jobId fixed) — the channel-wide poll is now its **own** daily job at the earliest user hour (`pollHour:00`), ahead of any per-user compose (ADR-0009). Stale-pool prune rides on it. The discovery worker is concurrency 1, so even if the poll runs long the earliest user (`hour:10`) just queues behind it.

Fail-open by design: a Redis outage reports "no cooldown" rather than wedging downloads/discovery shut.

### Demand shaping & the circuit breaker (ADR-0012)

The July 2026 block outlived the cooldown machinery (three days, one re-probe per ~12 h, each re-tripping), so the system now surrenders early and downloads far less:

- **`DOWNLOAD_DAILY_BUDGET`** (default 10) — global cap on *automated* downloads per UTC day, enforced in the slate-composition loop (`src/modules/discovery/index.ts`): slate-bound (delighter) picks are funded before follow-sourced ones; over-budget picks revert to `scored` in the candidate pool and get re-picked on a later slate. Explicit share-sheet / on-demand requests count toward the tally but are **never refused**. Priority ordering is per-run, not global across users — accepted approximation at 10/day.
- **`BACK_CATALOGUE_ENABLED`** (default `true`, set `false` in `.env` since 2026-07-20) — kill-switch for the back-catalogue seeder (full moratorium per ADR-0012; the pool-to-consumption ratio says depth is already banked).
- **Circuit breaker** (`src/circuit-breaker.ts`, threshold constant 3) — on the 3rd consecutive bot-detection trip, both queues auto-pause (same lever as `pipeline-pause.ts`) and Steve gets exactly one ntfy alert (`eddy:ytdlp:circuit-open` SET NX dedupes across M4 + worker; a failed send releases the claim so a later trip re-alerts). **No auto-resume** — dark until manual.
- **Resume is manual and dual-path**: `pipeline-pause.ts resume-if-clear` probes the M4 anonymous path *and* the worker's mweb+POT path over SSH (`eddy-mediaserver`); both must clear. Any resume path also clears the cooldown, strike counter, and breaker flag ("resume means go now").
- **`pipeline-pause.ts clear-parked`** — drains parked download jobs without a resume-burst: removes delayed/waiting jobs, marks their `downloading` rows `failed` (non-destructive), and resets their candidate-pool rows to `scored` so the slate re-selects them under budget. Side effect of the supporting dedup change: `failed` request rows no longer permanently block a video's re-selection.

**Orphaned-`downloading` fix (issue #183):** the worker now owns the terminal transition on attempt-exhaustion. When a download spends its full BullMQ retry budget on a non-terminal error, the worker posts `/internal/requests/:id/failed` (→ `mark_failed`) so the row leaves `downloading` immediately, instead of orphaning there until the watchdog escalation maybe rescues it. With the cooldown above, bot-detection retries *park* rather than exhaust, so this fires for genuinely failing downloads; either way the row no longer hangs.

**Restart-proof watchdog escalation (issue #184):** the in-server download watchdog (`src/modules/watchdog/index.ts`, 5-min cycle) used to give up on a stuck `downloading` row only after re-enqueueing it a fixed number of times, counted in an **in-memory `Map`**. The M4 server runs as `tsx watch` under launchd and restarts often; every restart wiped the counter, so the give-up window never completed and stuck rows re-enqueued **every 5 min forever** — exactly the pressure-on-a-blocked-IP failure the note above warns about. The watchdog now escalates on **elapsed time** instead: a stuck row past `ESCALATION_AGE_MS` (15 min, measured from its stored `requested_at`) is marked `failed` rather than re-enqueued, a verdict that's identical no matter how many times the process bounced. Rows whose BullMQ job is still healthy-pending (`active`/`waiting`/`delayed`/…) are skipped regardless of age, so a worker outage never escalates a queued job.

### Discovery metadata source (#189, ADR-0011)

Discovery's **metadata** reads (search, channel uploads, durations, channel bio/avatar) can come from yt-dlp scraping or the **YouTube Data API v3** — the structural fix for the volume problem the throttling above only mitigates, since the API takes that traffic off the residential IP entirely. **Downloads always stay on yt-dlp.** Selected by one `.env` knob:

- **`DISCOVERY_SOURCE`** (`ytdlp` default | `api`) — where the four metadata functions read from. The seam is `src/discovery-metadata.ts`; every discovery call site imports from there, so the flip is config-only and reversible per-deploy. Flipping it needs `npm run deploy -- --server`.
- **`YOUTUBE_API_KEY`** — required when `DISCOVERY_SOURCE=api` (zod `superRefine` fails startup otherwise). A plain Google Cloud API key with the *YouTube Data API v3* enabled — read-only public data, **no OAuth, no billing account**. It is a secret: `.env` only, never committed, name-only in `.env.example`.

**Quota:** the free tier is **10,000 units/day**, resetting midnight Pacific. `search.list` costs **100 units**; every other call (`videos.list`, `playlistItems.list`, `channels.list`) costs **1**. Current fleet use is ~3.9k/day, dominated by interest-search. `youtubeapi.ts` keeps a coarse local tally (reset on the UTC day) and logs a one-shot `warn` at 80%; `getQuotaUsage()` exposes the running total.

**On exhaustion, discovery skips and warns — no fallback to yt-dlp scraping** (by design; falling back reintroduces the IP load this removes). A `quotaExceeded` error breaks out of the interest-search and back-catalogue loops for the rest of that run, log-only (no ntfy), mirroring the bot-detection stand-down. If you see the 80%/exhaustion warnings routinely, the fleet has outgrown the free tier — raise the quota in Google Cloud or trim search depth (`DISCOVERY_SEARCH_LIMIT`), don't paper over it.

---

## Block incidents — diagnostics & IP-stack discipline

When a "Sign in to confirm you're not a bot" wall hits, the first job is to tell a **real IP-level botgate** apart from an **extractor/client problem** — they have opposite fixes and the wrong guess wastes days.

**Step zero — the incognito test.** From a browser on the **same public IP** as the boxes, open an incognito/private window (logged out, no cookies) and try to play any YouTube video.

- **Incognito playback also fails** → the IP itself is gated. yt-dlp can't out-clever this; quiet time or an egress change is the only fix. Stand down (let the cooldown/breaker do their thing) and wait.
- **Incognito plays fine but yt-dlp still fails** → it's an extractor/client problem, not the IP. Update yt-dlp (nightly), check the POT stack. **Quiet time will not fix this** — don't sit out a block that isn't there.

This split is the yt-dlp maintainers' own first-line triage (issue #15583). Do it before touching any knob.

### IP-stack awareness

Blocks are scored **per stack** — IPv4 and IPv6 are separate reputation buckets — and IPv6 reputation is scored per **/64 delegated prefix**, not per address. On UK residential ISPs that /64 often stays **sticky across an IPv4 WAN change**, so rotating the public IPv4 can leave a blocked IPv6 /64 untouched. This is the leading hypothesis for why the July 2026 block survived a WAN IPv4 change: both boxes were egressing IPv6 on the same sticky delegated /64.

At incident time, record **both stacks' egress** in your incident notes so you can see which one moved:

```bash
# from the worker
curl -4 https://ifconfig.co
curl -6 https://ifconfig.co
```

Keep those addresses **in your incident notes, never in this repo** — no real IPs in git, ever.

### `YTDLP_IP_STACK` — pin one stack

**`YTDLP_IP_STACK`** (`.env`, enum `ipv4` | `ipv6` | `auto`, default `ipv4`) forces every yt-dlp invocation on **both boxes** — downloads **and** the resume-if-clear probes — onto one stack, so probes and downloads share a single reputation bucket rather than splitting across two and muddying which stack is actually blocked. Flipping the var (e.g. `ipv4` → `ipv6`) is the cheap first move when the pinned stack is blocked but the incognito test shows the other stack is clean.

### Why fewer touch-points, not smaller downloads

YouTube appears to score **fresh anonymous sessions per IP**, not bytes transferred or download counts (yt-dlp maintainers, issues #14899 / #15865). That's why the fix direction is **fewer yt-dlp touch-points** — video and channel search now go through the Data API (`DISCOVERY_SOURCE=api`, see *Discovery metadata source* above) — rather than shrinking downloads. A smaller download is still one more anonymous session; a search that never touches yt-dlp is zero.

### `YTDLP_GUEST_COOKIES` — the aged guest-visitor jar

The download path can reuse **one persisted anonymous "guest visitor" identity** instead of minting a fresh session every run — an aged never-logged-in cookie jar passes gates that fresh sessions fail (yt-dlp #15583; per-IP session scoring #14899 / #15865). This is **not an account login** — nothing to ban; ADR-0012's 2026-07-20 amendment narrows rule 5 to permit exactly this.

**What / where.** A Netscape cookie jar **on the worker**, outside the repo — e.g. `/home/<user>/.local/state/eddy/guest-cookies.txt`. Point `YTDLP_GUEST_COOKIES` (`.env`) at it as an **absolute path with no spaces**: the download path checks it with Node `fs` (no `~` expansion — a tilde value silently disables the jar for downloads while the SSH probe's remote shell *does* expand it, so probe and downloads would diverge). Empty/unset (default) = fresh anonymous session per run, prior behaviour. A configured-but-missing file logs a warn and reverts to fresh-per-run — it never fails a download. Applies to worker downloads and the `resume-if-clear` worker probe (so the probe tests the identity downloads use); the M4 anonymous probe stays cookieless by design.

**Mint one** (on the worker). Run the same invocation the resume probe uses, adding `--cookies <path>` against a known-good video — one YouTube touch creates and populates the jar:

```bash
# on the worker
mkdir -p ~/.local/state/eddy
~/.local/bin/yt-dlp --force-ipv4 \
  --cookies ~/.local/state/eddy/guest-cookies.txt \
  --js-runtimes node:node --remote-components ejs:github \
  --extractor-args youtube:player_client=mweb --sleep-requests 1.5 \
  --dump-json --no-playlist --skip-download --no-write-playlist-metafiles \
  'https://www.youtube.com/watch?v=jNQXAC9IVRw' >/dev/null
```

**Age it.** Leave the jar unused ideally **3+ days** before it drives real downloads — a brand-new jar reads much like a fresh session. Do NOT log in to anything with it; a single anonymous touch is the whole point.

**Rotate.** If blocks recur while the jar is in use, **delete the file** (behaviour reverts to fresh-session-per-run) and, once the block has cleared, mint a fresh one and age it again. The jar is disposable — that is why this is safe.

**Hard rule.** Never use a **logged-in account's** cookies here. Guest-visitor (never-logged-in) only. An account under bot suspicion gets banned, not rate-limited, and crosses the brief's anonymity line (§256).

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
