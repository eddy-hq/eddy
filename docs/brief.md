# Eddy — Implementation Document

**Draft.** Single-developer build, sequential phases. Each phase produces something the family can use.

---

## 1. Why

### The situation we're actually in

Kids don't use YouTube because it's where the videos are. They use it for three different reasons that usually get treated as one:

- A friend sends them a link on WhatsApp or iMessage
- Something comes up at school and they want to look it up
- The feed has learned what holds them and is serving more of it

The first two are real. The third is a dopamine engine. The standard household response — screen-time limits, content restrictions, blocked apps — treats all three the same, and the kids correctly perceive it as unfair. Blocking the engine also blocks the social layer, and a twelve-year-old who can't watch what their friends are talking about feels it as parents not trusting them, not as good parenting.

The adults have the adult version of the same problem. Flipboard, YouTube, X — engineered to catch you on your way to somewhere else. "I'll check briefly" turns into forty minutes that nobody chose.

We don't need to lecture anyone about this. Everyone in the house already knows.

### What Eddy is

Eddy is a family media space that honours the real requests and quietly removes the engagement traps.

**For the kids**, it feels like a service that's on their side. When a friend sends a link, they share it to Eddy and it comes back watchable, usually within minutes, on their own screen, playing cleanly. When something comes up at school, they search for it. When Eddy can't get something to them, it says why in one sentence and there's a button to ask a grown-up. They should feel looked-after, not watched.

**For the adults**, it's a daily read. Articles, podcasts, papers, video — things worth attention, laid out like a magazine. No feed designed to keep them past the thing they came for.

**For the household**, it's one place where media lives, one set of controls, managed in plain language when those controls need to change.

### What Eddy is for

Three goods, in this order:

**1. Serve the real request.** If someone asks for something, the default is yes. Eddy's job is to get it to them, fast, on their terms. The only reasons not to are concrete and visible — not taste, not algorithm, not "we decided you'd like this less."

**2. Replace the dopamine loop with something that earns its time.** The feed shows things that match real interests, presented without tricks. No autoplay. No infinite scroll. No "you might also like" engineered to catch an impulse. Finishing the feed is a valid state. Going away is the intended outcome.

**3. Build media literacy, not dependence.** Over a year, a kid using Eddy should understand more about their own media consumption than they did at the start. They should be able to read their own signals — what they kept watching, what they skipped, where their time went — and form their own view of it. The long goal is a fifteen-year-old who can look at a TikTok feed and see what it's doing to them, because Eddy taught them to look.

### The rules that fall out of this

If these three goods are the why, a handful of rules follow — and anything in the rest of the brief that contradicts them is wrong and needs changing.

- **The kid's experience is never punitive.** Rejections come with reasons and an appeal path. Waiting is explained. Limits are visible. Nothing is silent.
- **No surveillance surfaces on kids' screens.** Streaks, summaries, and signals exist to help the kid understand themselves — never to be optimised against a target set by someone else.
- **No automated recommendation without a visible reason.** Every suggested item shows, in one line, why it was chosen. If we can't explain it, we don't surface it.
- **Private by default.** Kids' consumption never leaves the house. Adult consumption leaves only when the adult sends it.
- **Infrastructure serves experience.** The blocker, the guard, the pipeline — these exist to deliver the three goods. If they get in the way, they lose.

Everything that follows is a means to this. When a decision is hard, we come back here.

---

## 2. Household

Four users, three active in v1.

| User | Role | Notes |
|---|---|---|
| Steve | Parent, primary admin | Full profile, MCP access |
| Son 1 (12) | Kid | iPhone + WhatsApp + iMessage. Parent-managed profile. |
| Son 2 (10) | Kid | iPhone + iMessage. Parent-managed profile. |
| Partner | Parent | Added when she opts in. DNS blocking also gated on this. |

Partner's profile and the Pi-hole blocker both wait for her explicit buy-in. Everything else ships first — the system should be useful to the kids before the blocking layer is ever turned on.

---

## 3. Hardware & network

Two machines, already configured.

**M4 Mac Mini (16GB, macOS)** — Eddy itself. One Node process, SQLite, BullMQ + Redis, Ollama with Gemma 4 E4B resident, PWA dev and production build.

**2012 Mac Mini (16GB i7, Ubuntu Server 24.04)** — media host. Existing: Plex + Plex Pass, Radarr/Sonarr/Prowlarr/qBittorrent (untouched by Eddy). Adding: nginx (for PWA video streaming), Pi-hole (later phase).

**Storage on Ubuntu:**
- **HDD** — existing Plex library. Untouched.
- **SSD** — `/mnt/ssd/eddy/videos/`. Eddy writes via SSH/SMB mount from M4. nginx serves to PWA. Plex scans for TV playback as a separate "Other Videos" library (no agent matching, avoids YouTube IDs confusing IMDB lookups).

**Eddy owns the directory.** yt-dlp writes, Eddy deletes, Plex and nginx read. No other service touches it.

**Network:** BT Home Hub 2 as router. Tailscale across both machines and all family devices (kids already on it for Plex). The HH2 cannot push DNS to DHCP clients, so Pi-hole will only reach Tailscale-joined devices. This covers the family but not guests or smart-home devices — fine, stated explicitly.

**TV devices:** Apple TV (recent) on Tailscale. Fire Stick and Fire OS TV not on Tailscale — parent grants overrides by local IP when needed.

---

## 4. Architecture

One Node codebase, one database, one PWA. Two processes — one on each machine — sharing a Redis queue.

**Principle: Ubuntu moves bytes, M4 thinks.** The M4 runs over WiFi; Ubuntu is on Ethernet next to the router. Anything that shifts large payloads runs on Ubuntu so video doesn't cross WiFi twice. Anything that reasons or serves small responses runs on the M4.

```
┌─────────────────────── M4 Mac Mini (WiFi) ───────────────────┐
│                                                              │
│  Node process — API, PWA, reasoning                          │
│    ├── profiles                                              │
│    ├── requests      (kid request flow, orchestration)       │
│    ├── sources       (RSS, podcasts, papers — small fetches) │
│    ├── feed          (aggregation, scoring, hook generation) │
│    ├── guard         (Gemma)                                 │
│    ├── drift         (weekly literacy summary)               │
│    ├── overrides     (Pi-hole API, override lifecycle)       │
│    ├── notifications (ntfy client)                           │
│    └── mcp           (MCP server for Claude.ai control)      │
│                                                              │
│  SQLite (single file, owned by M4)                           │
│  Ollama + Gemma 4 E4B                                        │
│  PWA (React, built by Vite, served by Express)               │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            │  Tailscale (small payloads only)
                            ▼
┌─────────────────── Ubuntu Server (Ethernet) ─────────────────┐
│                                                              │
│  Download worker — Node process, same codebase               │
│    ├── yt-dlp         (download + transcript fetch)          │
│    ├── ffmpeg         (mux, stream copy, no re-encode)       │
│    └── callback       (POSTs results back to M4 API)         │
│                                                              │
│  Redis  — BullMQ queue (on Ethernet for low-latency pulls)   │
│  nginx  — serves /mnt/ssd/eddy/videos/ to PWA                │
│  Plex   — scans same directory, serves to TVs                │
│  ntfy   — notification delivery to all family devices        │
│  Pi-hole (later) — DNS blocking for Tailscale clients        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Why this split

The M4 is in the back room on WiFi. Ubuntu is next to the router on Ethernet. If downloads ran on the M4, every video would cross the WiFi link twice — once inbound from YouTube to M4, once outbound from M4 to Ubuntu's SSD. The second hop competes with the first for the same airtime, roughly halving effective bandwidth. Moving the worker to Ubuntu makes the path single-hop on Ethernet and eliminates the WiFi bottleneck entirely.

Side effect: Gemma 4 E4B (~10GB resident) stops competing with yt-dlp+ffmpeg for memory and CPU on the 16GB M4. Inference stays fast, the PWA stays snappy.

### Process topology

- **M4 Node process** — API, PWA, MCP, all modules listed above. Enqueues download jobs, writes SQLite on callback.
- **Ubuntu Node process** — download worker only. Same codebase, different entry point (`src/workers/download.ts`). Connects to Redis on Ubuntu. Pulls download jobs, runs yt-dlp + ffmpeg to local disk, POSTs to M4 API on completion.
- **Redis on Ubuntu** — queue lives next to the worker that consumes from it. M4 pushes jobs over Tailscale (small payloads).
- **SQLite on M4** — single source of truth. Ubuntu worker never writes SQLite directly; it reports results via M4's internal API.

### Module boundaries

No microservices, but two processes. Modules are TypeScript files, not network hops. Shared code lives in `src/` and is compiled once; both entry points import from the same modules. The boundary between processes is *the BullMQ queue* and one internal callback endpoint (`POST /internal/videos/:id/downloaded` with HMAC auth).

**Language:** TypeScript / Node.js throughout. No Python — yt-dlp is a binary shell-out on Ubuntu.

---

## 5. The request flow

This is the load-bearing feature. Everything else is in service of it.

### From the kid's perspective

A friend sends a YouTube link on WhatsApp. The kid long-presses, taps **Share → Eddy**. The PWA opens briefly and says one of:

- **"Ready — tap to watch"** (already in library)
- **"Getting it — about 3 minutes"** (downloading, push when done)
- **"Waiting for a grown-up"** (escalated to parent, with reason shown)
- **"Eddy can't get this one: {reason}. Ask a grown-up?"** (rejected, with one-tap appeal)

No case is silent. No case is punitive.

### The two entry points

**Primary: iOS Shortcut as share target.** Installed once per kid's device. Appears in the iOS share sheet alongside "Copy", "Messages", etc. Tapping it POSTs the URL to Eddy and opens the PWA deep-linked to the pending item. Two taps from any app: *share → Eddy*.

**Safety net: DNS-block landing page.** When Pi-hole is live (later phase), blocked YouTube domains resolve to a tiny local page on the Ubuntu box: *"Looks like you're trying to watch something. Open in Eddy?"* URL prefilled, one tap submits the request. Turns every block into a redirect, not a wall.

**Pre-Pi-hole (phase 1):** primary path only. Kids learn to use share sheet. If they tap a link directly they reach YouTube as normal — that's fine, the goal isn't perfect capture, it's making Eddy the obvious easier path.

### Pipeline

```
Shortcut POSTs url → requests module
        ↓
yt-dlp pulls metadata + auto-subs (no video yet, ~5s)
        ↓
Guard module — fast triage:
        ├── clear-yes     → approve, queue download
        ├── clear-no      → reject with reason, appeal button to kid
        └── uncertain     → escalate to parent push, kid sees "waiting"
        ↓
Parent taps approve / deny in push
        ↓
Download (yt-dlp → /mnt/ssd/eddy/videos/{youtube_id}.mp4, H.264)
        ↓
Plex scan trigger (Plex API) — video available on TV within ~30s
        ↓
Push to kid: "Ready"
```

### Rate limits

Soft daily cap per kid. 10 requests/day, resets at 6am. Over the cap, everything goes to parent — not punitive, just a signal. A kid who burns ten requests on one creator has told us something useful about interest. Adjustable in MCP.

### Time-sensitive content

Some requests can't wait — livestreams, football matches, reaction content where the social moment is now. These hit the override path, not the pipeline: parent-granted temporary direct YouTube access on the requesting device for N minutes. Much narrower than an always-on override — only for what genuinely can't be pipelined.

---

## 6. Content pipeline (downloads)

yt-dlp directly, running on Ubuntu. No Tube Archivist.

### Where the work happens

Downloads run on Ubuntu via a dedicated Node worker process sharing the BullMQ queue with the M4's API. The M4 enqueues a job with the URL and metadata; the Ubuntu worker pulls it, runs yt-dlp + ffmpeg to local disk, and POSTs back to the M4's internal API on completion. See Section 4 for the full topology and rationale.

**M4 never touches video files.** It holds nginx URLs in SQLite and that's all.

### yt-dlp invocation

```
yt-dlp \
  --format "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][vcodec^=avc1]" \
  --concurrent-fragments 4 \
  --write-auto-sub --sub-lang en \
  --no-part \
  -o /mnt/ssd/eddy/videos/{id}.mp4 \
  {url}
```

- **H.264 + AAC forced** — native browser playback, no transcoding, Plex direct-play on TVs. ffmpeg runs only to mux the streams (stream copy, no re-encode). Verify with `--verbose` that ffmpeg logs `Stream mapping` with `(copy)` on both streams — if it shows `(encode)`, the format selector is wrong and CPU is being burned for nothing.
- **`--concurrent-fragments 4`** — YouTube serves video in fragments; pulling them in parallel is typically 2-3× faster on modern sources.
- **`--no-part`** — writes directly to the final filename. Cheap on local disk, avoids a rename step.
- Metadata and auto-subs stored in SQLite for guard + hook generation.

### Queue configuration

- **Concurrency 2** on the Ubuntu worker — room for two downloads in parallel without saturating the uplink or the SSD.
- **Retries 3×** with exponential backoff.
- **Job payload is small** — URL, youtube_id, user_id, destination filename. No binary data on the queue.

### Plex integration

- Plex library configured as "Other Videos" type (no agent matching) pointing at `/mnt/ssd/eddy/videos/`.
- On download completion, the Ubuntu worker triggers a partial Plex scan via Plex API — video on TV within ~30s of being ready.
- Plex is pure reader. No metadata writing, no deletion from Plex — all file operations are Eddy's.

### Subscriptions (light layer, not the heartbeat)

- Each kid picks a handful of channels they actually follow.
- Every 6 hours, a scheduled job on the M4 checks channel RSS feeds and enqueues download jobs for any new videos.
- New videos go through the same guard pipeline as requests — same rules, same escalation.
- Approved channel content appears in the feed tagged as "from channels you follow."

### Deletion

- **Watched** → delete within 24 hours. Frees space quickly.
- **Storage threshold** (configurable, default 80% full) → oldest-unwatched first, skipping anything saved, dismissed, or added in the last 48h.
- **Dismissed** → not deleted immediately, but first in line when threshold hits. Deprioritised, not punished.

Deletion runs as a scheduled job on Ubuntu (the file owner), triggered by the M4. Deletion log kept in SQLite.

### Reliability & operations

YouTube ships breaking changes to yt-dlp every 1-3 months on average; the yt-dlp community typically fixes within 24-48 hours. Tube Archivist would not protect against this — it uses the same engine. The mitigation is operational, not architectural:

- **Auto-update yt-dlp weekly** via cron on Ubuntu (`pip install -U yt-dlp`). Stale installs are the single biggest reliability factor.
- **Pipeline health check** — BullMQ job every 15 minutes. If >50% of last 10 downloads failed, send a single ntfy notification to Steve with two actions: `[Update & retry]` (runs `pip install -U yt-dlp` on Ubuntu then retries failed jobs from the last 24h) and `[Investigate]` (opens the admin queue view in the PWA). One alert per failure cluster, not per failure. Steve triggers the remediation, not the system — keeps the human in the loop for the cases where the upstream fix isn't out yet.
- **Manual retry button** in the PWA admin view as a fallback path.
- **Error mapping** — yt-dlp returns structured errors. Map common cases to kid-readable reasons:
  - `age-restricted` → *"This one's age-restricted on YouTube. Ask a grown-up?"*
  - `private` / `removed` / `unavailable` → *"This video isn't available any more."*
  - `geo-blocked` → *"This video isn't available in our country."*
  - `members-only` → *"This is for channel members only."*
  - Anything unrecognised → *"Eddy hit a problem — trying again later."* (logged for Steve)

The kid never sees a silent failure. Worst case (YouTube breaks yt-dlp overnight) is a ~24h delay on requests, with the queue intact and Steve one push notification away from a one-tap fix.

### Tracking subscribed channels

`seen_videos` table — `(channel_id, video_id, seen_at)`. yt-dlp pulls channel RSS, Eddy ignores anything already in `seen_videos`, processes the rest through the guard pipeline. Trivial replacement for what TA does internally.

---

## 7. Sources beyond YouTube

For the adult feed primarily; kids get a lightweight version later.

**Adult sources:**
- RSS feeds (news, Substack, blogs) — fetched hourly
- Podcast RSS — episode metadata only, no download
- arXiv / PubMed RSS — for AI, fitness, nutrition topics

**Kids sources (v2, after the YouTube flow is bedded in):**
- Selected age-appropriate RSS (BBC Newsround, National Geographic Kids, etc.)
- Only added once the kids are actually using Eddy daily — no point building it speculatively.

Eddy fetches metadata and links only. No content extraction, no scraping. Cards link to original source — articles open Safari, podcasts open the default podcast app. Video is the only content type Eddy hosts locally, because it's the only one where the platform itself is the problem.

---

## 8. The feed (PWA)

The feed is the ambient second surface — the primary interaction is the request flow. But it matters, because it's where the kids and adults spend non-request time.

### Structure

Same card component for every content type. Content type badge distinguishes them. Tap destinations vary:

- Video (ready) → inline PWA playback, HTML5 full-screen
- Article → Safari
- Podcast → podcast app deep link, fallback to browser
- Paper → Safari

Card shows: image/thumbnail, topic pill, source, headline, **one-sentence personal hook** (why this item for this user, generated by Gemma at scoring time), duration/read time.

### Personal hook

Every card has a hook line beneath the headline. Max 15 words, direct, specific not generic. Generated by Gemma in batches (not per-card-on-demand — 10-20 items per inference call, far cheaper). Falls back to a one-line description if generation fails.

This is where the "no recommendation without a visible reason" rule lives. If the hook says something generic like "You might like this," the system has failed and should fall back to the description.

### Feed modes

- **Magazine** (default) — single hero card, page-turn to advance. Feels editorial.
- **List** — denser, faster scanning, hook truncated to one line.

Toggle persisted per user. Finishing the feed is a valid state — no infinite scroll, no "more suggestions for you" below the last item.

### iPad layouts

- ≥768px (portrait) — two-column editorial spread
- ≥1024px (landscape) — editorial with left sidebar topic filter

### Interactions

- **Tap** → open/play. Primary action, only action for most.
- **🔖 Bookmark** → save for later. Small, top-right of card. Quiet pulse, card stays.
- **✕ Dismiss** → not interested. Small, top-right. Card fades, slides away. Negative signal for storage priority, not instant delete.
- **Long press** → more options (share, more like this, why this).
- **Dwell** — IntersectionObserver tracks >5s visibility without dismiss = positive signal, silent.

No swipe-as-primary. No gesture demands. The system reads the quiet signals.

### Cover splash

On app open, a brief cover — date, count, top story image. One second, then feed. First run shows a welcome instead. Sets the tone: curated, not a scroll.

### Search

yt-dlp metadata search. Kid types a query, sees titles/channels/durations/thumbnails, taps request. Covers the "something came up at school" case. Channel search works the same way — request to follow a channel, approved by parent (kids) or auto-approved (adults).

---

## 9. The guard

Gemma 4 E4B as triage, not adjudicator. Parent as adjudicator. Frontier model as optional future middle-tier judge once we have data.

### Three outcomes

For every request (YouTube URL from share sheet, new subscribed-channel video, search-and-request, etc.):

- **Clear-yes** → approve, queue download. Kid sees "getting it." Fast-path for obvious fine content (Mr Beast, football highlights, Minecraft builds from established channels).
- **Clear-no** → reject with one-sentence reason + appeal button. Fast-path for obvious bad (explicit terms, age-rated, hard-exclusion keywords).
- **Uncertain** → escalate to parent push. Kid sees "waiting for a grown-up." Parent taps approve or deny.

### Signals Gemma considers

- Title + channel + description
- Auto-generated transcript (if available)
- Channel reputation (past approvals/rejections in SQLite)
- Keyword hard-exclusions from kid's profile
- Age-appropriate framing for kid's age bracket

### Evaluation

Before tuning prompts, build an eval set. 100 labelled examples per kid — pulled from their first weeks of real requests, labelled by Steve. Gemma tuned against this set until:

- **Clear-yes precision ≥95%** (false yes = unsafe content reaching kid — expensive)
- **Clear-no precision ≥90%** (false no = good content wrongly rejected — annoying but appealable)
- **Uncertain rate 10-30%** (higher = parent overload, lower = Gemma overconfident)

No go-live on automatic approval until these thresholds hit. Until then, everything escalates to parent. This is fine — the escalation flow is designed for that load.

### Frontier escalation (Phase 8, optional)

Once ~200 parent decisions are in SQLite, evaluate whether Claude API calls on uncertain cases reliably match parent judgement. If yes, route uncertain → Claude API → if still uncertain → parent. Reduces parent load without reducing safety. Cost: a few cents per household-day. Defer until data is in hand.

### Appeals

Every reject shows the reason and a one-tap "Ask a grown-up" button. Parent sees the original URL, Gemma's reasoning, and approve/deny. Appeal decisions feed back into the eval set over time.

---

## 10. Drift — the literacy surface

Weekly. Not a score to optimise. A mirror to read.

### For kids

Every Sunday evening, Eddy generates a one-page summary:

- **How you spent your time this week** — topic breakdown, visual bars, plain language
- **What you kept watching** — completion rate, favourite creators this week
- **What you asked for and got** — requested vs pipeline-surfaced
- **One observation** — a Gemma-written sentence noticing a pattern (*"You watched a lot of Minecraft tutorials this week and finished most of them — looks like you're learning something specific."*)

No number. No target. No comparison to a prior week's score. A streak counter exists but it tracks *diversity of topics* (stretching, not concentrating) rather than volume — and it's always optional to view.

The kid can tap any row for a one-sentence explanation of what Eddy is noticing. Over months, the kid learns the vocabulary of their own attention.

### For parents

Same underlying data, richer view:

- All the kid-facing signals
- Request approval/rejection summary
- Channels trending up/down in the kid's attention
- Profile adjustment candidates — *"Son 1 has dismissed 8/10 football videos this week; suggest reducing football weight?"* Never auto-applied.
- Red-flag surface — e.g. sharp drop in diversity, or request spike late at night — as a quiet notification, not a push

### Adult Drift

Same mechanic, applied to the adult's own consumption. No one else sees it. A private mirror.

### Naming

The weekly summary is called **Drift** throughout. The eddy-and-current metaphor without the ambiguity of "current" as both noun and adjective. A kid's Drift view in the PWA answers: *where is my attention going this week, and does that match where I want it to go?*

### Baseline

First 3-4 weeks per user show "Getting to know you" instead of Drift content. Any earlier and the signal is noise.

---

## 11. Overrides & blocking (Phase 6, gated)

Not built until partner is bought in.

### Pi-hole

- Docker on Ubuntu, DNS for Tailscale-joined devices only.
- Default state: **disabled**. Infrastructure ready, blocking off, until household decision to go live.
- Block list: `youtube.com`, `m.youtube.com`, `youtu.be`, `youtubei.googleapis.com`. **Not** `googlevideo.com` in v1 — shared CDN, risks breaking Google Meet / embedded players. Phase 2 decision once we see what happens.
- Always-open list: `plex.tv`, `bbc.co.uk`, `itvx.com`, Tailscale domains.
- Steven Black hosts blocklist for general ad/tracker blocking across all devices — separate layer, enabled by default.

### DNS-block landing page

When the kid taps a YouTube link without share-sheet, the DNS lookup is intercepted and they land on a simple nginx page: *"Open this in Eddy?"* with URL prefilled. One tap submits the request, kid stays in flow.

This is the whole reason blocking is worth doing — every block becomes a redirect into the system that serves them.

### Override (for the narrow cases)

Livestreams, football, time-sensitive social moments. Parent grants temporary YouTube access per device for N minutes:

- Kid taps "Request YouTube time" in PWA
- ntfy notification to both parents with action buttons: `[30 min] [1 hour] [Deny]` (priority `max`, bypasses DND)
- First parent to tap wins. Pi-hole whitelists the kid's Tailscale IP for the duration.
- 10-minute warning notification to kid (priority `high`). Expiry auto-revokes whitelist. Notification to kid and parent.

TVs: parent grants by device name from phone. Not on Tailscale, so managed by local IP registration in Eddy.

See Section 12 for the full notification system.

### Go-live criteria (household decision, not automated)

- Kids using Eddy daily for requests — several weeks
- Gemma guard or parent-decision flow running smoothly — queue not backed up
- DNS-block landing page tested end-to-end
- Partner explicitly on board

---

## 12. Notifications

One system for everyone, every event class: **ntfy, self-hosted on the Ubuntu box.**

### Why ntfy

- Free, open source, single Docker container alongside nginx and Pi-hole on Ubuntu
- iOS app supports HTTP action buttons that POST to a URL — fits the signed-token pattern below
- Priority levels map to iOS interruption levels — `max` priority bypasses DND for parent approvals
- Per-user topics with ACL — kids can't see each other's notifications
- Tailscale-internal — no public exposure of the ntfy server itself

### iOS delivery caveat

Apple's APNs requires a registered developer account, which self-hosted services can't have. ntfy works around this by forwarding tiny poll-request messages (just a message ID, no content) to upstream `ntfy.sh`, which has APNs access. The iOS app then fetches actual message content from your self-hosted server.

In practice: message content stays on the Ubuntu box; only opaque message IDs transit ntfy.sh. If ntfy.sh has an outage, instant push pauses until either it recovers or the iOS app foregrounds. Their uptime has been good — months between incidents. Acceptable trade-off given everything else stays local.

### Topics & auth

One topic per user, named with a UUID component so guessing is infeasible:

- `eddy-steve-{uuid}`
- `eddy-partner-{uuid}`
- `eddy-son1-{uuid}`
- `eddy-son2-{uuid}`

ntfy basic auth + ACL configured per user. Each user's iOS app stores credentials for their own topic only. Pipeline failures and other admin events go to parent topics with `high` priority — no separate system topic.

### Events and priorities

| Event | Recipient | Priority | Actions |
|---|---|---|---|
| Guard escalation (parent decision needed) | parents | `max` | `[Approve] [Deny]` |
| Override request | parents | `max` | `[30 min] [1 hour] [Deny]` |
| Override granted | kid | `default` | Tap → open PWA |
| Override expiring (10 min warning) | kid | `high` | Tap → open PWA |
| Override expired | kid + parent | `default` | — |
| Video ready | kid | `default` | Tap → play in PWA |
| Request rejected with appeal available | kid | `default` | `[Ask a grown-up]` |
| Pipeline failure cluster | Steve | `high` | `[Update & retry] [Investigate]` |
| Weekly Drift ready | per-user | `low` | Tap → open Drift view |

### Signed-token pattern for action endpoints

Action buttons need to call back to Eddy without a full auth flow.

When Eddy sends a notification with actions:

1. Generate a short-lived signed token (HMAC-SHA256, 1 hour TTL, single-use)
2. Action URL: `https://eddy.tail-xxxx.ts.net/action/{handler}?token={token}`
3. Endpoint validates the signature and TTL, looks up the token in `used_tokens`, runs the handler if unused, marks it used, returns a confirmation page or PWA deep-link

Single-use prevents replay. Short TTL bounds the window. The PWA admin view shows a log of all action invocations for debugging. Same pattern for every action across every notification.

### Setup (Phase 1)

- Add ntfy Docker container to Ubuntu compose
- Configure with `upstream-base-url: https://ntfy.sh` for iOS instant delivery
- Create users and topics via ntfy CLI; store topic and credentials in Eddy's user profile JSON
- Install ntfy iOS app on each family device, configure default server to the Tailscale URL of the Ubuntu box, subscribe to the user's topic
- Build a thin notification adapter in Eddy's `notifications` module — single ntfy client used by every other module that needs to send

---

## 13. MCP (Claude as control plane)

Natural-language management via Claude.ai. Adults only.

| Tool | Purpose |
|---|---|
| `get_profile` / `update_profile` | Read/write adult profiles |
| `get_kid_summary` | Kid's Drift (visual signals only, no consumption detail) |
| `get_requests_queue` | Pending, approved, rejected |
| `approve_request` / `deny_request` | Action from Claude.ai |
| `get_active_overrides` | What's currently unblocked |
| `grant_override` / `revoke_override` | Override control |
| `update_block_groups` | Pi-hole config |
| `set_pipeline_state` | Pause/resume any module |
| `holiday_mode` | Pause pipeline, disable blocking, remember prior state |
| `get_system_status` | Pipeline health, queue depth, storage |

### Privacy enforcement (hard rule)

- Kids' real names and ages never exposed. MCP responses substitute `kid_1`, `kid_2`.
- Kids' consumption detail (titles watched, specific creators, watch times) never in MCP responses. Only the Drift summary visuals, which are already designed for parent eyes.
- Adult profile and consumption detail accessible only when the adult themselves is asking.

Tested with integration tests. Any MCP response that fails the privacy filter throws rather than sends.

### Holiday mode

```
"Eddy, we're on holiday for two weeks"
→ pipeline paused, blocking disabled, prior state remembered

"Eddy, we're back"
→ prior state restored
```

---

## 14. Privacy

| Data | Stays local | Can leave (via MCP, when you ask) |
|---|---|---|
| Video titles, channels, watch history | ✓ | ✗ |
| Kids' profiles, consumption, Drift detail | ✓ | ✗ (ever) |
| Article tap history | ✓ | ✗ |
| Adult profile topics | ✓ | ✓ |
| Adult Drift summary | ✓ | ✓ |
| System status, queue depth | ✓ | ✓ |

No automated external calls in v1. Claude API usage (Phase 8, optional) requires explicit config and logs every call.

---

## 15. Data model

SQLite, single file, backed up nightly to Ubuntu. All tables have `user_id`.

```sql
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT,
  age_gate      BOOLEAN DEFAULT 0,
  profile       TEXT,  -- JSON
  created_at    TIMESTAMP
);

CREATE TABLE devices (
  device_id     TEXT PRIMARY KEY,
  display_name  TEXT,
  owner_user_id TEXT,
  tailscale_ip  TEXT,
  local_ip      TEXT,
  device_type   TEXT   -- phone|tablet|tv|desktop
);

CREATE TABLE requests (
  request_id       TEXT PRIMARY KEY,
  user_id          TEXT,
  source           TEXT,     -- share_sheet|search|channel_subscription|dns_landing
  url              TEXT,
  youtube_id       TEXT,
  title            TEXT,
  channel          TEXT,
  status           TEXT,     -- pending|guard_review|parent_review|approved|rejected|downloading|ready|watched|dismissed
  guard_verdict    TEXT,     -- clear_yes|clear_no|uncertain
  guard_reason     TEXT,
  decided_by       TEXT,     -- 'gemma'|user_id
  rejection_reason TEXT,
  file_path        TEXT,
  nginx_url        TEXT,
  duration_secs    INTEGER,
  requested_at     TIMESTAMP,
  decided_at       TIMESTAMP,
  downloaded_at    TIMESTAMP,
  watched_at       TIMESTAMP
);

CREATE TABLE content_items (
  item_id       TEXT PRIMARY KEY,
  user_id       TEXT,
  content_type  TEXT,     -- video|article|podcast|paper
  title         TEXT,
  source        TEXT,
  url           TEXT,
  topic         TEXT,
  score         REAL,
  personal_hook TEXT,     -- Gemma-generated, <=15 words
  tapped        BOOLEAN DEFAULT 0,
  saved         BOOLEAN DEFAULT 0,
  dismissed     BOOLEAN DEFAULT 0,
  completed     BOOLEAN DEFAULT 0,
  dwell_secs    INTEGER DEFAULT 0,
  added_at      TIMESTAMP,
  tapped_at     TIMESTAMP
);

CREATE TABLE topics (
  id           TEXT PRIMARY KEY,
  label        TEXT,
  emoji        TEXT,
  search_terms TEXT,      -- JSON array
  category     TEXT,
  age_gate     BOOLEAN DEFAULT 0,
  source       TEXT       -- seed|user_added
);

CREATE TABLE user_topics (
  user_id    TEXT,
  topic_id   TEXT,
  weight     REAL DEFAULT 1.0,
  liked      BOOLEAN DEFAULT 1,
  added_at   TIMESTAMP,
  PRIMARY KEY (user_id, topic_id)
);

CREATE TABLE overrides (
  override_id   TEXT PRIMARY KEY,
  user_id       TEXT,
  device_id     TEXT,
  granted_by    TEXT,
  duration_mins INTEGER,
  expires_at    TIMESTAMP,
  status        TEXT,     -- active|expired|revoked
  created_at    TIMESTAMP
);

CREATE TABLE drift (
  user_id       TEXT,
  week          TEXT,     -- ISO: "2026-W15"
  summary       TEXT,     -- JSON: signals, observations, one-sentence
  calculated_at TIMESTAMP,
  PRIMARY KEY (user_id, week)
);

CREATE TABLE guard_eval (
  eval_id        TEXT PRIMARY KEY,
  request_id     TEXT,
  url            TEXT,
  gemma_verdict  TEXT,
  gemma_reason   TEXT,
  human_verdict  TEXT,    -- labelled by Steve for eval set
  human_notes    TEXT,
  created_at     TIMESTAMP
);

CREATE TABLE used_tokens (
  token_hash TEXT PRIMARY KEY,
  handler    TEXT,
  user_id    TEXT,
  used_at    TIMESTAMP
);

CREATE TABLE seen_videos (
  channel_id  TEXT,
  video_id    TEXT,
  seen_at     TIMESTAMP,
  PRIMARY KEY (channel_id, video_id)
);
```

---

## 16. Design system

Deliberate, restrained, editorial. No Tailwind. CSS custom properties consumed directly.

### Fonts

- **Source Serif 4** (variable, Google Fonts) — headlines, card titles, hook lines
- **DM Sans** (variable, Google Fonts) — UI, labels, metadata

### Tokens

```css
/* Type scale */
--text-xs: 11px   --text-sm: 13px   --text-base: 15px   --text-md: 17px
--text-lg: 20px   --text-xl: 24px   --text-2xl: 30px    --text-3xl: 38px

/* Light mode */
--bg-primary: #FAFAF8    --bg-surface: #FFFFFF      --bg-elevated: #F5F4F1
--text-primary: #1A1916  --text-secondary: #6B6860  --text-tertiary: #A8A59E
--accent: #3D6B6B        --accent-subtle: rgba(61,107,107,0.10)
--save: #3A7D5A          --dismiss: #B85450
--border-subtle: rgba(26,25,22,0.08)

/* Dark mode */
--bg-primary: #1A1916    --bg-surface: #222220
--text-primary: #F0EFE9  --text-secondary: #9A9890

/* Spacing — 4px base */
--space-1: 4px through --space-16: 64px

/* Radius */
--radius-sm: 6px  --radius-md: 12px  --radius-lg: 16px  --radius-xl: 24px

/* Shadow */
--shadow-card:  0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)
--shadow-modal: 0 8px 48px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.10)

/* Motion */
--ease-out-cubic: cubic-bezier(0.33, 1, 0.68, 1)
--ease-spring:    cubic-bezier(0.34, 1.56, 0.64, 1)
--duration-fast: 150ms  --duration-normal: 250ms  --duration-slow: 350ms
```

### Card anatomy

```
┌─────────────────────────────────┐
│   [image — 16:9]       [🔖][✕] │   Icons top-right, small, --text-tertiary
│   [content type badge]          │   Top-left of image, semi-transparent
├─────────────────────────────────┤
│  [topic pill]  ·  [source]      │   DM Sans --text-xs, uppercase
│                                 │
│  Headline wraps to two lines    │   Source Serif 4 --text-lg, --text-primary
│                                 │
│  "Personal hook, one sentence." │   Source Serif 4 italic --text-base, --text-secondary
│                                 │
│  4 min  ·  2 hours ago          │   DM Sans --text-xs, --text-tertiary
└─────────────────────────────────┘
```

Tap targets 44×44 minimum despite small visual icons.

### Named motion

- **Card tap** — scale 1.0 → 0.97 → 1.0, ease-spring, 80ms/200ms
- **Dismiss** — fade to 0.3 over 200ms, slide up, next card rises. No drama.
- **Save** — bookmark fills with accent pulse, 200ms ease-spring
- **Page turn** (magazine) — 350ms ease-in-out, slight parallax on image
- **Cover splash** — 600ms stagger, auto-transition to feed
- **`prefers-reduced-motion`** — all animations disabled

### Frontend stack

- React 18 + Vite
- Framer Motion for named animations
- Zustand for local state, TanStack Query for API
- Lucide for icons, Radix for accessibility primitives
- No Tailwind, no CSS-in-JS, no Storybook. A single `/design-reference` route in the PWA shows every component in every state — serves as the design doc.

---

## 17. Build plan

Eight phases. Sequential. Each ends with something the family uses.

### Phase 0 — Foundation (1 session)

- Single TypeScript repo, two entry points planned: `src/server.ts` (M4) and `src/workers/download.ts` (Ubuntu)
- Schema + migrations
- Config (.env with all variables, .env.example committed, zod-validated)
- Logger, error types, Ollama wrapper, BullMQ queue setup
- **Redis on Ubuntu** via Docker, reachable from M4 over Tailscale
- **SQLite on M4**, nightly backup script to Ubuntu
- Hello-world route on M4, reachable over Tailscale
- HMAC-authed internal API endpoint stub for worker → M4 callbacks

**Ends with:** M4 Node process running, Redis on Ubuntu reachable from M4, database initialised, Ollama responding.

### Phase 1 — The request flow, minimum viable (2 sessions)

- **ntfy** Docker container on Ubuntu, configured with upstream forwarding for iOS instant delivery
- ntfy iOS app installed on each family device, topics configured per user, credentials stored in user profiles
- `notifications` module in Eddy with thin ntfy client, signed-token URL pattern for action endpoints
- iOS Shortcut installer — documented setup, one Shortcut per kid's device (pin as share-sheet Favourite)
- `POST /requests` endpoint on M4 — enqueues download job on Redis
- **Download worker on Ubuntu** (`src/workers/download.ts`) — pulls jobs, runs yt-dlp + ffmpeg locally, writes to `/mnt/ssd/eddy/videos/`, POSTs result to M4's internal API
- systemd service for the worker, auto-restart on failure
- yt-dlp with `--concurrent-fragments 4`, `--no-part`, H.264 format selector
- nginx on Ubuntu serving the videos directory to PWA
- Plex library configured, API-triggered scan from Ubuntu worker on download complete
- Simplest PWA — two routes: `/request?url=...` (landing for Shortcut) and `/my-requests` (list with states)
- "Video ready" ntfy notification working end-to-end
- **No guard yet** — everything auto-approves in this phase. Steve watches the queue and rejects anything bad manually.

**Ends with:** kids can share a YouTube link to Eddy and it comes back watchable, fast, with a notification on their phone. No WiFi round-trip for video bytes.

### Phase 2 — The feed (2 sessions)

- Card component, design tokens, all named animations
- Feed layout — magazine mode, list mode, iPad portrait + landscape
- Inline video player (HTML5, full-screen, state machine)
- Search via yt-dlp metadata
- Channel subscriptions — kids pick a handful of channels; periodic RSS check adds new videos to their feed, going through the same request pipeline
- Cover splash, topic filter, bottom nav
- `/design-reference` route as living design doc

**Ends with:** a proper feed PWA with search, subscriptions, and inline playback. Still no automated guard — subscribed-channel new-videos go to parent review queue.

### Phase 3 — The guard (1-2 sessions)

- Gemma prompts for triage (clear-yes / clear-no / uncertain)
- Eval set: 100 labelled examples per kid from real Phase 1-2 data
- Tune prompts until thresholds hit (95% clear-yes precision, 90% clear-no, 10-30% uncertain rate)
- Wire Gemma into the request pipeline — replaces manual approval for clear cases
- Uncertain cases go to parent push with approve/deny inline actions
- Appeal flow — kid taps "Ask a grown-up" on rejects, parent sees it
- Ship with caution: first month, parent reviews a sample of Gemma's clear-yes decisions too, to catch drift

**Ends with:** ~70-80% of requests auto-handled by Gemma, parents only see the uncertain ones plus appeals. Big reduction in parent load.

### Phase 4 — Sources & scoring (1 session)

- RSS ingestion (articles, podcasts, papers) — adult feed
- Gemma scoring against profile + personal hook generation (batched)
- Unified feed rendering (video + article + podcast + paper cards)
- Dismiss/save/dwell signal capture

**Ends with:** adult feed is a proper daily read. Kid feed still video-only.

### Phase 5 — Drift (1 session)

- BullMQ repeatable Sunday evening job
- Kid view: topic breakdown, what-you-kept-watching, what-you-asked-for, one Gemma observation. No number.
- Adult view: full mirror of own consumption
- Parent view: kids' Drift summaries with profile adjustment candidates (never auto-applied)
- Baseline period — first 3-4 weeks shows "Getting to know you"

**Ends with:** weekly literacy surface working. Kids start learning to read their own signals.

### Phase 6 — Overrides & blocking (1-2 sessions, gated on partner buy-in)

- Pi-hole Docker on Ubuntu, configured but disabled
- Override request/grant/expiry lifecycle
- Web Push inline actions + PWA fallback for approve/deny
- DNS-block landing page on Ubuntu nginx
- Go-live checklist — only when the four criteria are met

**Ends with:** DNS blocking live, landing page redirecting to Eddy. The request flow now captures nearly all YouTube attempts, not just share-sheet ones.

### Phase 7 — MCP (1 session)

- MCP server module in same Node process
- Tools for profile, queue, overrides, system status
- Privacy enforcement layer — kid names never exposed, consumption detail never in responses
- Integration tests on the privacy layer specifically
- Holiday mode

**Ends with:** Steve can manage the whole system from Claude.ai in plain language.

### Phase 8 — Frontier escalation (optional, data-driven)

- Only if 6+ months of parent-decision data shows middle-tier cases have consistent patterns Claude could learn
- Route Gemma-uncertain → Claude API → if still uncertain → parent
- Log every Claude call
- Measure reduction in parent load vs false-negative rate before shipping to kids

**Ends with:** parents only see the genuinely hard decisions. Maybe.

---

## 18. Out of scope for v1

- Partner profile (video and content feeds) — added when she's in
- TikTok replacement (blocked via Pi-hole, no pipeline)
- Plex-to-Jellyfin migration
- Hosted / SaaS version
- Mobile native apps
- Fire OS / Fire Stick app — parent grants by local IP
- Kids' sources beyond video (Phase N+1, after the video flow is bedded in)
- Automated profile tuning from Drift signals (suggestions only, always manual apply)

---

## 19. Open questions

Resolve before or during the relevant phase.

1. **Shortcuts availability on Son 2's iPhone.** Screen Time may restrict Shortcut installation. Verify this week before committing to Phase 1 primary path.
2. **Plex scan trigger latency.** Plex API `library.refresh` may not reliably pick up a single new file — may need to scan the whole "Other Videos" library each time. Measure in Phase 1.
3. **SMB vs SSH mount from M4 to Ubuntu SSD.** yt-dlp writing over the network — measure throughput, choose simpler option.
4. **Gemma inference throughput on M4 with 16GB RAM.** Can it handle scoring + hook generation + triage on a busy day without swap? Instrument in Phase 3, adjust batch sizes if needed.
5. **Whole-house DNS coverage (Phase 6 decision).** BT Home Hub 2 cannot push DNS to DHCP clients, so Pi-hole only reaches Tailscale-joined devices. Options if whole-house coverage is wanted: (a) try Pi-hole as DHCP server with HH2 DHCP disabled — fragile but free; (b) replace HH2 with a UniFi Cloud Gateway Ultra (~£140) or similar, putting HH2 in modem mode if BT line allows. Decide at start of Phase 6 — Tailscale-only coverage may prove sufficient once kids are using share-sheet for most requests.
6. **yt-dlp auto-update strategy.** Weekly cron is the baseline. Consider: check version on each download attempt and update if >7 days stale, vs simple weekly cron. Decide in Phase 1 once we see actual failure rate.

### Known dependencies

- **ntfy.sh upstream** is required for instant iOS push delivery (poll-request forwarding). Their uptime has been good but it is a single point of failure outside our control. If it becomes a real problem, the alternative is a £79/year Apple Developer account and a custom iOS app — significant effort for a low-probability mitigation. Live with the dependency for now.

---

## 20. Project identity

- **Name:** Eddy — a current that moves differently to the main flow.
- **Weekly summary name:** Drift.
- **Repo:** `eddy-hq/eddy`
- **Licence:** MIT
- **Open source:** when stable (post-Phase 5). The universal problem means community improvements to the guard and profile system would help more families than solo development could.