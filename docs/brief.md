# Eddy — Implementation Document

**Status:** Phase 2 in progress. Phase 0-1 shipped. Videos download via Shortcut and play in the PWA.

Reasoning and trade-offs that led to these decisions live in `docs/decisions.md`. This document is the spec.

---

## 1. Why

### The situation

Kids use YouTube for three different reasons that usually get treated as one:

- A friend sends them a link on WhatsApp or iMessage
- Something comes up at school and they want to look it up
- The feed has learned what holds them and is serving more of it

The first two are real. The third is a dopamine engine. Standard household responses — screen-time limits, blocked apps — treat all three the same, and kids correctly perceive it as unfair. Blocking the engine also blocks the social layer.

Adults have the adult version of the same problem: Flipboard, YouTube, X, engineered to catch you on your way somewhere else.

### What Eddy is

A family media space that honours real requests and quietly removes engagement traps.

- **For kids** — a service that's on their side. Shared links come back watchable within minutes. Rejections come with reasons and an appeal path. They feel looked-after, not watched.
- **For adults** — a daily read. Articles, podcasts, papers, video, laid out like a magazine. No feed designed to keep them past what they came for.
- **For the household** — one place where media lives, one set of controls, managed in plain language.

### Three goods, in order

1. **Serve the real request.** If someone asks for something, the default is yes. The only reasons not to are concrete and visible.
2. **Replace the dopamine loop with something that earns its time.** No autoplay, no infinite scroll, no "you might also like" engineered to catch an impulse. Finishing the feed is a valid state.
3. **Build media literacy, not dependence.** Over a year, a kid using Eddy should understand more about their own media consumption than they did at the start.

### Non-negotiable rules

- **The kid's experience is never punitive.** Rejections come with reasons and an appeal path. Waiting is explained. Nothing is silent.
- **No surveillance surfaces on kids' screens.** Streaks and summaries exist to help the kid understand themselves.
- **No automated recommendation without a visible reason.** Every suggested item shows, in one line, why.
- **Private by default.** Kids' consumption never leaves the house.
- **Infrastructure serves experience.** Blocker, guard, pipeline exist to deliver the three goods.

If any decision below contradicts these rules, the decision is wrong.

---

## 2. Household

| User | Role | Notes |
|---|---|---|
| Steve | Parent, primary admin | Full profile, MCP access |
| Son 1 (12) | Kid | iPhone + WhatsApp + iMessage. Parent-managed profile. |
| Son 2 (10) | Kid | iPhone + iMessage. Parent-managed profile. |
| Partner | Parent | Added when she opts in. DNS blocking also gated on this. |

Partner's profile and the Pi-hole blocker both wait for her explicit buy-in.

---

## 3. Hardware & network

**M4 Mac Mini (16GB, macOS, WiFi)** — Eddy API, PWA, SQLite, Ollama with Gemma 4 E4B.

**2012 Mac Mini (16GB i7, Ubuntu Server 24.04, Ethernet next to router)** — existing Plex + arr stack (untouched by Eddy). Adds: download worker, Redis, nginx, ntfy, Pi-hole (later).

**Storage on Ubuntu:**
- HDD — existing Plex library, untouched
- SSD — `/mnt/ssd/eddy/videos/`. Eddy owns. yt-dlp writes, Eddy recycles, Plex and nginx read.

**Network:** BT Home Hub 2. Tailscale across both machines and all family devices. HH2 cannot push DNS to DHCP clients — Pi-hole will only reach Tailscale-joined devices. Fine, stated explicitly.

**TV devices:** Apple TV on Tailscale. Fire Stick and Fire OS TV not on Tailscale — parent grants overrides by local IP.

---

## 4. Architecture

One codebase, two Node processes, one database.

**Principle: Ubuntu moves bytes, M4 thinks.** Anything shifting large payloads runs on Ubuntu (Ethernet). Anything reasoning or serving small responses runs on the M4. Video doesn't cross WiFi twice; Gemma doesn't compete with ffmpeg for memory.

```
┌─────────────────────── M4 Mac Mini (WiFi) ───────────────────┐
│  Node process — API, PWA, reasoning                          │
│    profiles · requests · sources · feed · guard · drift      │
│    overrides · notifications · mcp                           │
│                                                              │
│  SQLite (single file, owned by M4, nightly backup to Ubuntu) │
│  Ollama + Gemma 4 E4B                                        │
│  PWA (React, built by Vite, served by Express)               │
└──────────────────────────────────────────────────────────────┘
                            │  Tailscale (small payloads only)
                            ▼
┌─────────────────── Ubuntu Server (Ethernet) ─────────────────┐
│  Download worker — Node, same codebase, different entry      │
│    yt-dlp · ffmpeg mux · callback to M4 API                  │
│                                                              │
│  Redis  — BullMQ queue (on Ethernet for low-latency pulls)   │
│  nginx  — serves /mnt/ssd/eddy/videos/ to PWA                │
│  Plex   — scans same directory, serves to TVs                │
│  ntfy   — notification delivery to all family devices        │
│  Pi-hole (later) — DNS blocking for Tailscale clients        │
└──────────────────────────────────────────────────────────────┘
```

### Module boundaries

Modules are TypeScript files, not network hops. Shared code in `src/`; both entry points import from the same modules. The only cross-process boundary is the BullMQ queue and one HMAC-auth'd callback endpoint (`POST /internal/videos/:id/downloaded`).

Ubuntu worker never writes SQLite directly — it reports results via M4's internal API.

**Language:** TypeScript / Node.js throughout. yt-dlp is a binary shell-out.

### Client-agnostic contracts

Every client-facing interaction is plain HTTP with a clean JSON contract. No PWA-only cleverness in the data layer.

**Canonical URL paths** are documented once and used everywhere. Protocol is variable:
- `https://eddy.tail-xxxx.ts.net/request/{id}` — PWA
- `eddy://request/{id}` — native app when it ships

Same paths both forms. Switching consumers is a protocol prefix change, not a route rewrite.

---

## 5. The request flow

The load-bearing feature. Everything else is in service of it.

### Kid's perspective

Friend sends a YouTube link on WhatsApp. Kid long-presses, taps **Share → Eddy**. PWA opens briefly and says one of:

- **"Ready — tap to watch"** — already in library
- **"Getting it — about 3 minutes"** — downloading, notification when done
- **"Waiting for a grown-up"** — escalated to parent, with reason shown
- **"Eddy can't get this one: {reason}. Ask a grown-up?"** — rejected, with one-tap appeal

No case is silent. No case is punitive.

### Entry points

**Primary: iOS Shortcut as share target.** Installed once per device, pinned as share-sheet Favourite. Two taps: *share → Eddy*.

Shortcut structure:
1. Receive shared URL
2. `POST [base]/requests` with the URL — response includes `{ "path": "/request/{id}" }`
3. `Open URL [base][path]`

`[base]` is a Shortcut variable. Today: `https://eddy.tail-xxxx.ts.net`. When native ships: `eddy://`. Same Shortcut, two modes.

**Safety net (Phase 6): DNS-block landing page.** Blocked YouTube domains resolve to a local page: *"Looks like you're trying to watch something. Open in Eddy?"* URL prefilled, one tap submits. Every block becomes a redirect, not a wall.

### Pipeline

```
Shortcut POST → requests module
        ↓
yt-dlp metadata + auto-subs (~5s)
        ↓
Guard triage:
  ├── clear-yes   → approve, queue download
  ├── clear-no    → reject with reason, appeal button
  └── uncertain   → escalate to parent, kid sees "waiting"
        ↓
Parent approve/deny via ntfy notification (if escalated)
        ↓
Download → /mnt/ssd/eddy/videos/{youtube_id}.mp4, H.264
        ↓
Plex scan trigger → video on TV within ~30s
        ↓
"Ready" notification to kid
```

### Rate limits

Soft daily cap per kid: **10 requests/day**, resets 6am. Over the cap, everything escalates to parent. Not punitive — signal. Adjustable via MCP.

### Time-sensitive content

Livestreams, football matches, reaction content where the social moment is *now* — these hit the override path (Section 11), not the pipeline. Parent grants temporary direct YouTube access on the requesting device for N minutes.

---

## 6. Content pipeline (downloads)

yt-dlp directly, running on Ubuntu. No Tube Archivist. M4 never touches video files.

### yt-dlp invocation

YouTube gates downloads behind PO Tokens. yt-dlp can't generate these itself — requires a browser/mobile attestation runner. Use the **[bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)** plugin, installed on Ubuntu alongside yt-dlp. yt-dlp discovers it on PATH.

```
yt-dlp \
  --extractor-args "youtube:player_client=default,mweb" \
  --sleep-interval 5 --max-sleep-interval 10 \
  --format "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][vcodec^=avc1]" \
  --concurrent-fragments 4 \
  --write-auto-sub --sub-lang en \
  --no-part \
  -o /mnt/ssd/eddy/videos/{id}.mp4 \
  {url}
```

Flag notes: `mweb` client is the path the plugin supports. Sleep intervals keep us polite and avoid rate-limiting. H.264 + AAC forced — ffmpeg stream-copies only, no re-encode (verify with `--verbose` that both streams show `(copy)`). Concurrent fragments give 2-3× throughput. `--no-part` skips a rename step on local disk.

Metadata and auto-subs stored in SQLite for guard + hook generation.

### No Google credentials in the kids' path

Kids download anonymously. No cookies, no account. Age-restricted and members-only content fails — that's the right outcome for kids, turned into a kid-readable rejection with appeal. An adult code path with throwaway-account cookies may come later for adult-only downloads.

### Queue configuration

- Concurrency 2 on the Ubuntu worker
- Retries 3× with exponential backoff
- Job payload: URL, youtube_id, user_id, destination filename. No binary data on the queue.

### Plex integration

- Library type "Other Videos" (no agent matching) pointing at `/mnt/ssd/eddy/videos/`
- On download completion, Ubuntu worker triggers partial Plex scan via API
- Plex is pure reader. All file operations are Eddy's.

### Subscriptions

- Each kid picks a handful of channels they actually follow
- Every 6 hours, M4 checks channel RSS feeds and enqueues download jobs for new videos
- New videos go through the same guard pipeline as requests

### Storage recycling

The feed is a forever timeline (Section 8). Content items are never removed from SQLite — only the underlying video files are recycled when disk pressure requires it.

**When files are recycled:**

- Only at storage threshold (configurable, default 80% full). Not time-based.
- Priority order (first-to-recycle → last):
  1. Dismissed items
  2. Watched items, oldest first
  3. Unwatched items, oldest first, skipping last 48h
  4. Saved items — never recycled
- `file_state` transitions `live` → `recycled`. `file_path` and `nginx_url` cleared. Row preserved.

**Restore (one tap):** same yt-dlp pipeline re-runs. Original guard verdict preserved — no re-triage. Card stays in its original timeline position.

**Non-restorable (`file_state` = `gone`):** YouTube removed the source, channel taken down, geo-block. "No longer available" treatment, offers to find similar via search.

Recycling runs as a scheduled job on Ubuntu.

### Reliability

YouTube is in an active arms race with download tools. Three failure modes, all operational:

1. **yt-dlp breaks** — YouTube ships changes every 1-3 months; fixes land in 24-48h
2. **PO Token plugin breaks** — same dynamic
3. **Rate-limiting** — *"This content isn't available, try again later"*. Recovery is to back off

**Mitigations:**

- Weekly cron on Ubuntu: `pip install -U yt-dlp bgutil-ytdlp-pot-provider`
- Pipeline health check BullMQ job every 15min. If >50% of last 10 downloads failed, send one ntfy notification to Steve with actions: `[Update & retry]` and `[Investigate]`. One alert per failure cluster.
- Rate-limit detection: on consecutive "try again later" responses, pause queue for an hour and notify Steve.
- Manual retry button in PWA admin view.

**Error mapping** (kid-readable):

- `age-restricted` → *"This one's age-restricted on YouTube. Ask a grown-up?"*
- `members-only` → *"This is for channel members only."*
- `private` / `removed` / `unavailable` → *"This video isn't available any more."*
- `geo-blocked` → *"This video isn't available in our country."*
- rate-limit → *"Eddy needs a short break — trying again in an hour."* (queue paused)
- PO token or unknown → *"Eddy hit a problem — trying again later."* (logged)

Kid never sees a silent failure. Worst case (yt-dlp *and* plugin both break overnight) is a 24h delay, queue intact, Steve one tap from a fix.

### Tracking subscribed channels

`seen_videos` table — `(channel_id, video_id, seen_at)`. yt-dlp pulls channel RSS; items already in `seen_videos` are skipped.

---

## 7. Sources beyond YouTube

Adult feed primarily. Kids get a lightweight version later.

- RSS feeds — articles, Substack, blogs — fetched hourly
- Podcast RSS — episode metadata only, no download
- arXiv / PubMed RSS — for AI, fitness, nutrition topics

Eddy fetches metadata and links only. No scraping. Cards link to original source — Safari for articles, podcast app for episodes. Video is the only content type Eddy hosts locally.

Kids' sources (BBC Newsround, Nat Geo Kids, etc.) added once the YouTube flow is bedded in.

---

## 8. The feed — a timeline

Reverse-chronological record of attention, anchored by **added date**. Persists forever. Watched items don't disappear; recycled files don't erase history.

### Anchor: added date

Every card sits in exactly one day — the day it was added to this user's feed. A video shared Monday and watched Friday lives in Monday's section with a secondary "Watched Friday" indicator. Anchor doesn't move.

The feed is *what was offered to me*. Drift is *what did I do with it*. Different questions, different surfaces.

### Structure

```
┌─ Today ────────────────────────────────────────────┐
│   My requests           (shared via Shortcut)      │
│   From your channels    (subscribed channel drops) │
│   Picked for you        (Phase 2.5 — discovery)    │
├─ Yesterday ────────────────────────────────────────┤
│   [unified list]                                   │
├─ Tuesday 8 April ──────────────────────────────────┤
│   [...continuous scroll back...]                   │
└────────────────────────────────────────────────────┘
```

**Today** is the only day with sub-sections — it's the only day still being written. Past days are unified lists.

**Continuous scroll only** in v1. Day headers separate sections. No date picker, no calendar, no time-jump.

### Card states

Three visual tiers reflecting file state:

- **Live** — file on disk, immediately playable. Full colour.
- **Recycled** — record remains, file recycled. Dimmed thumbnail, restore icon. One tap re-downloads.
- **Gone** — YouTube removed. Heavily dimmed, "No longer available", offers find-similar.

Watched state is an additional overlay — tick + "Watched Xh ago" replacing duration.

### iPad layouts

More of the timeline visible at once is the goal.

- **Portrait (≥768px)** — two-column grid within each day
- **Landscape (≥1024px)** — three-column grid, left sidebar with topic filter and search

Magazine mode (single hero, page-turn) is iPhone-only. iPad default is always grid.

### Card component

Content type badge distinguishes video / article / podcast / paper.

Tap destinations:
- Video (live) → inline PWA playback, HTML5 full-screen
- Video (recycled) → restore → play
- Video (gone) → find similar
- Article → Safari
- Podcast → podcast app deep link, fallback to browser
- Paper → Safari

Card shows: thumbnail, topic pill, source, headline, one-sentence personal hook, duration/read time. Past-day cards also show "Watched Xh later" if applicable.

### Personal hook

Every card has a hook line beneath the headline. Max 15 words, direct, specific not generic. Gemma-generated in batches (10-20 items per inference call). Falls back to one-line description if generation fails.

Where the "no recommendation without a visible reason" rule lives. Generic hooks ("you might like this") are a system failure and should fall back to description.

### Interactions

- **Tap** → open/play (or restore → play). Primary action.
- **🔖 Bookmark** → save for later. Small, top-right. Saved items immune to recycling.
- **✕ Dismiss** → card dims in place but stays in the timeline. First in line when recycling hits.
- **"Why this?"** (Phase 2.5+) → dedicated small affordance on discovery-surfaced cards. Shows reasoning in one sentence.
- **Long press** → more options (share, more like this).
- **Dwell** — IntersectionObserver tracks >5s visibility without dismiss as positive signal. Silent.

No swipe-as-primary. Dismissal is a quiet opt-out.

### Cover splash

On app open: brief cover — date, count, top story image. One second, transitions to Today. First run shows a welcome.

### Search

Full-text across the whole timeline via SQLite FTS5. Matches title, personal hook, channel, topic. Flat results list ordered by relevance, card's original date shown beneath. Also powers "find similar" for gone cards.

Text-only in v1. Filters (saved, channel, date range, topic) come in a later polish pass.

### Saved

Saved items appear in the timeline in original position *and* in a dedicated Saved tab. Saved tab is a forever list, reverse-chronological by save date. Saved items never recycled.

### New-content entry points

Separate from the timeline — how content *enters* the system:

- **Video search** — yt-dlp metadata search. Type query, see titles/channels/durations/thumbnails, tap request.
- **Channel search** — same interface, request to follow. Parent-approved for kids, auto-approved for adults.

---

## 9. The guard

Gemma 4 E4B as triage, parent as adjudicator. Frontier model as optional future middle-tier (Phase 8).

### Three outcomes

For every request (Shortcut, channel drop, search-and-request):

- **Clear-yes** → approve, queue download
- **Clear-no** → reject with one-sentence reason + appeal button
- **Uncertain** → escalate to parent via ntfy. Kid sees "waiting for a grown-up."

### Signals Gemma considers

- Title, channel, description
- Auto-generated transcript (when available)
- Channel reputation (past approvals/rejections in SQLite)
- Keyword hard-exclusions from kid's profile
- Age-appropriate framing for kid's age

### Evaluation

Build eval set before tuning. 100 labelled examples per kid from real requests, labelled by Steve. Tune Gemma until:

- **Clear-yes precision ≥95%** — false yes = unsafe content reaching kid
- **Clear-no precision ≥90%** — false no = good content wrongly rejected
- **Uncertain rate 10-30%** — higher = parent overload, lower = overconfident

Until thresholds hit, everything escalates to parent. First month after go-live, parent reviews a sample of clear-yes decisions too.

### Frontier escalation (Phase 8, optional)

Once ~200 parent decisions are in SQLite, evaluate whether Claude API calls on uncertain cases reliably match parent judgement. If yes, route uncertain → Claude API → if still uncertain → parent.

### Appeals

Every reject shows reason + one-tap "Ask a grown-up" button. Parent sees URL, Gemma's reasoning, approve/deny. Appeal decisions feed back into the eval set.

---

## 9a. Discovery and profile

Eddy proactively finds content worth surfacing. Small number of genuinely good picks per day, not an endless feed. Scarcity is a feature.

### Profile: three layers

**Layer 1 — Explicit.** Topics with weights, subscribed channels, hard exclusions (kids' invisible to them), duration preferences.

**Layer 2 — Behavioural.** Completion rate per topic/channel/duration-band, save rate, dwell-before-dismiss, re-watch count, requested-and-finished rate.

**Layer 3 — Inferred affinities.** Gemma-generated sentences describing shape of preference: *"Likes long-form technical explainers, not short listicles."* Internal only v1 — not exposed in UI. Kids see Layer 3 indirectly via "why this?" on picks.

### "Why this?"

Every item surfaced by discovery (not subscribed drops, not requests) has a small "why this?" affordance. Tap to see a user-appropriate one-sentence explanation.

Adult: *"You finished 5 of 7 videos on this channel last month, and this is their new upload."*

Kid: *"You watched loads of Minecraft redstone stuff last week and this channel makes the same kind of thing."*

If Gemma can't explain why, the item doesn't surface.

### Discovery sources

v1 (Phase 2.5):
- Subscribed channels (already exists)
- Topic search — daily `ytsearch20:'topic keywords'` for top-weighted topics
- Related-channel expansion — from last week's engaged items, pull channel metadata for collaborators and adjacent channels

v2 deferred:
- Curated external lists (Reddit, HackerNews, Awesome-X repos). Ship without; add if discovery quality proves thin.

**Not using:** YouTube Data API. Keeps discovery yt-dlp-only, avoids Google Cloud entanglement.

### The engine

Daily BullMQ job, runs early morning so Today is populated by breakfast:

```
For each active user:
  1. Refresh candidate pool
       - Pull subscribed channels
       - Run topic searches for top-N topics
       - Related-channel expansion on last week's engaged items
       - Dedupe against seen_videos and content_items
  2. Score candidates with Gemma
       - Batches of 10-20
       - Relevance × quality × popularity × freshness
       - Reject dismissed-pattern matches, blocked channels, hard-exclusions
  3. Guard pipeline for kids
       - Clear-yes → surface. Uncertain → parent queue. Clear-no → logged.
  4. Apply daily cap
       - Kids: 3-5 items. Adults: 10-20. Surplus retained for tomorrow.
```

### Scarcity

Cap is firm. Surplus carries forward but never inflates a single day. Finishing "Picked for you" is a valid state — show *"That's it for today — more tomorrow"* at the bottom rather than paginating.

### Balance: a choice, not imposed

When imbalance is pronounced (>70% one topic across multiple days, triggering at most once per 1-2 weeks), Eddy surfaces a single in-feed prompt — not a notification, not a nag:

> *"You've watched a lot of Minecraft recently. Want today's picks to stretch you a bit, or stay in the groove?"*
> [Stretch me] [Stay in the groove]

Both options lead to good picks. Stretch biases toward adjacent topics the user has shown mild interest in. Stay honours the current pattern. Not a punishment.

Kids see this too. Noticing your own patterns in real time is part of the literacy principle.

### Kid transparency

Kids see: their own topics/channels/durations, watch history via timeline, "why this?" on every surfaced item, balance prompts.

Kids don't see: hard exclusions (gaming risk), parent-only notes, raw confidence numbers, full Gemma reasoning on clear-no rejections, pipeline/queue internals.

Adults see everything about their own profile. Parents see full detail of kid profiles except real-time viewing (that would be surveillance).

### Cold start

First 3-4 weeks, behavioural signal is thin. "Picked for you" shows *"Eddy is still figuring out what you like — tell it more"* with a prompt to subscribe and rate. Aligns with Drift's "Getting to know you" baseline.

---

## 10. Drift — the literacy surface

Weekly. Not a score to optimise. A mirror to read.

### For kids

Every Sunday evening, Eddy generates a one-page summary:

- **How you spent your time this week** — topic breakdown, visual bars
- **What you kept watching** — completion rate, favourite creators
- **What you asked for and got** — requested vs pipeline-surfaced
- **One observation** — Gemma-written sentence: *"You watched a lot of Minecraft tutorials this week and finished most of them — looks like you're learning something specific."*

No number. No target. No week-on-week comparison. Optional streak counter tracks *topic diversity*, not volume.

Each row taps through to a filtered timeline view of the evidence. Drift is a guided tour of the week the kid can already see.

Observations may reference inferred affinities that drove discovery picks: *"You finished all 5 of the redstone tutorials Eddy picked this week — looks like that hunch was right."* The feedback loop is visible.

### For parents

Same data, richer view:
- All kid-facing signals
- Request approval/rejection summary
- Channels trending up/down
- Profile adjustment candidates — *"Son 1 dismissed 8/10 football videos this week; suggest reducing football weight?"* Never auto-applied.
- Red-flag surface (sharp diversity drop, late-night request spike) as a quiet notification, not a push

### Adult Drift

Same mechanic applied to own consumption. No one else sees it.

### Baseline

First 3-4 weeks per user shows "Getting to know you" instead of Drift content.

---

## 11. Overrides & blocking (Phase 6, gated)

Not built until partner is bought in.

### Pi-hole

- Docker on Ubuntu, DNS for Tailscale-joined devices only
- Default state: **disabled** until household decision
- Block list: `youtube.com`, `m.youtube.com`, `youtu.be`, `youtubei.googleapis.com`. **Not** `googlevideo.com` initially — shared CDN, risks breaking Google Meet and embedded players. Reconsider later.
- Always-open: `plex.tv`, `bbc.co.uk`, `itvx.com`, Tailscale domains
- Steven Black hosts blocklist for general ad/tracker blocking — separate layer, enabled by default

### DNS-block landing page

Blocked YouTube domain lookups resolve to a tiny nginx page: *"Open this in Eddy?"* with URL prefilled, one tap submits.

This is the reason blocking is worth doing — every block becomes a redirect, not a wall.

### Override

Livestreams, football, time-sensitive moments. Parent grants temporary YouTube access per device for N minutes:

- Kid taps "Request YouTube time" in PWA
- ntfy to both parents with actions: `[30 min] [1 hour] [Deny]` (priority `max`, bypasses DND)
- First parent to tap wins. Pi-hole whitelists kid's Tailscale IP for the duration.
- 10-min warning notification. Expiry auto-revokes. Notification to kid + parent.

TVs: parent grants by device name from phone.

### Go-live criteria

- Kids using Eddy daily for requests — several weeks
- Guard/parent-decision flow running smoothly
- DNS-block landing page tested end-to-end
- Partner explicitly on board

---

## 12. Notifications

One system for everyone, every event class: **ntfy, self-hosted on the Ubuntu box.**

### iOS delivery model

ntfy forwards tiny poll-request messages (message ID only, no content) to upstream `ntfy.sh` for APNs delivery. iOS app fetches actual message content from your self-hosted server.

Content stays on Ubuntu; only opaque IDs transit ntfy.sh. If ntfy.sh has an outage, instant push pauses until recovery or iOS app foregrounds.

### Topics

One topic per user, UUID-suffixed so guessing is infeasible:

- `eddy-steve-{uuid}`
- `eddy-partner-{uuid}`
- `eddy-son1-{uuid}`
- `eddy-son2-{uuid}`

Basic auth + ACL per user. Each iOS app stores credentials for its own topic only.

### Events and priorities

| Event | Recipient | Priority | Actions |
|---|---|---|---|
| Guard escalation | parents | `max` | `[Approve] [Deny]` |
| Override request | parents | `max` | `[30 min] [1 hour] [Deny]` |
| Override granted | kid | `default` | Tap → open PWA |
| Override expiring (10 min) | kid | `high` | Tap → open PWA |
| Override expired | kid + parent | `default` | — |
| Video ready | kid | `default` | Tap → play in PWA |
| Request rejected with appeal | kid | `default` | `[Ask a grown-up]` |
| Pipeline failure cluster | Steve | `high` | `[Update & retry] [Investigate]` |
| Weekly Drift ready | per-user | `low` | Tap → open Drift view |

### Signed-token action endpoints

Action buttons call back without a full auth flow.

When Eddy sends a notification with actions:
1. Generate short-lived signed token (HMAC-SHA256, 1h TTL, single-use)
2. Action URL: `https://eddy.tail-xxxx.ts.net/action/{handler}?token={token}`
3. Endpoint validates signature + TTL, looks up token in `used_tokens`, runs handler if unused, marks used, returns confirmation or PWA deep-link

Same pattern for every action across every notification.

### Module interface

```typescript
notify(user_id: string, event: EventType, payload: EventPayload): Promise<void>
```

Everything else in the codebase calls this. Today it's ntfy; tomorrow (native iOS) it's direct APNs. Narrow interface, not a plugin abstraction.

---

## 13. MCP (Claude as control plane)

Adults only.

| Tool | Purpose |
|---|---|
| `get_profile` / `update_profile` | Read/write adult profiles |
| `get_kid_summary` | Kid's Drift (visual signals only, no consumption detail) |
| `get_requests_queue` | Pending, approved, rejected |
| `approve_request` / `deny_request` | Action from Claude.ai |
| `get_active_overrides` | Currently unblocked |
| `grant_override` / `revoke_override` | Override control |
| `update_block_groups` | Pi-hole config |
| `set_pipeline_state` | Pause/resume any module |
| `holiday_mode` | Pause pipeline, disable blocking, remember prior state |
| `get_system_status` | Pipeline health, queue depth, storage |

### Privacy enforcement (hard rule)

- Kids' real names and ages never exposed. MCP responses substitute `kid_1`, `kid_2`.
- Kids' consumption detail (titles, creators, watch times) never in MCP responses. Only Drift summary visuals.
- Adult profile and consumption detail accessible only when the adult themselves is asking.

Tested with integration tests. Any MCP response that fails the privacy filter throws rather than sends.

### Holiday mode

*"Eddy, we're on holiday for two weeks"* → pipeline paused, blocking disabled, prior state remembered.

*"Eddy, we're back"* → prior state restored.

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

SQLite, single file on M4, nightly backup to Ubuntu. All tables have `user_id`.

```sql
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT,
  age_gate      BOOLEAN DEFAULT 0,
  profile       TEXT,                -- JSON
  created_at    TIMESTAMP
);

CREATE TABLE devices (
  device_id     TEXT PRIMARY KEY,
  display_name  TEXT,
  owner_user_id TEXT,
  tailscale_ip  TEXT,
  local_ip      TEXT,
  device_type   TEXT                 -- phone|tablet|tv|desktop
);

CREATE TABLE requests (
  request_id       TEXT PRIMARY KEY,
  user_id          TEXT,
  source           TEXT,              -- share_sheet|search|channel_subscription|dns_landing
  url              TEXT,
  youtube_id       TEXT,
  title            TEXT,
  channel          TEXT,
  status           TEXT,              -- pending|guard_review|parent_review|approved|rejected|downloading|ready|watched|dismissed
  guard_verdict    TEXT,              -- clear_yes|clear_no|uncertain
  guard_reason     TEXT,
  decided_by       TEXT,              -- 'gemma'|user_id
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
  item_id          TEXT PRIMARY KEY,
  user_id          TEXT,
  content_type     TEXT,              -- video|article|podcast|paper
  title            TEXT,
  source           TEXT,
  channel          TEXT,
  url              TEXT,
  topic            TEXT,
  score            REAL,
  personal_hook    TEXT,              -- Gemma-generated, <=15 words
  why_this         TEXT,              -- Gemma reasoning for discovery picks; null for requests/subs
  thumbnail_url    TEXT,              -- persisted so recycled cards still render
  duration_secs    INTEGER,
  file_path        TEXT,              -- null when recycled or non-video
  nginx_url        TEXT,              -- null when recycled or non-video
  file_state       TEXT DEFAULT 'live', -- live|recycled|gone|na (non-video)
  added_section    TEXT,              -- my_request|channel|recommendation
  discovery_source TEXT,              -- null|topic_search|related_channel|external_list
  tapped           BOOLEAN DEFAULT 0,
  saved            BOOLEAN DEFAULT 0,
  dismissed        BOOLEAN DEFAULT 0,
  completed        BOOLEAN DEFAULT 0,
  dwell_secs       INTEGER DEFAULT 0,
  re_watch_count   INTEGER DEFAULT 0,
  added_at         TIMESTAMP,         -- anchor for timeline position; immutable
  tapped_at        TIMESTAMP,
  watched_at       TIMESTAMP,
  saved_at         TIMESTAMP,
  dismissed_at     TIMESTAMP,
  recycled_at      TIMESTAMP
);

CREATE VIRTUAL TABLE content_items_fts USING fts5(
  title, personal_hook, channel, topic,
  content='content_items', content_rowid='rowid'
);

CREATE TABLE candidate_pool (
  candidate_id     TEXT PRIMARY KEY,
  user_id          TEXT,
  content_type     TEXT,
  url              TEXT,
  youtube_id       TEXT,
  title            TEXT,
  channel          TEXT,
  discovery_source TEXT,              -- topic_search|related_channel|external_list
  discovered_at    TIMESTAMP,
  scored_at        TIMESTAMP,
  score            REAL,
  surfaced         BOOLEAN DEFAULT 0,
  surfaced_at      TIMESTAMP,
  rejected         BOOLEAN DEFAULT 0,
  rejection_reason TEXT
);

CREATE TABLE inferred_affinities (
  affinity_id    TEXT PRIMARY KEY,
  user_id        TEXT,
  statement      TEXT,                -- sentence form
  confidence     REAL,
  evidence_items TEXT,                -- JSON array of item_ids
  user_confirmed TEXT,                -- null|yes|no|sort_of (later phases)
  created_at     TIMESTAMP,
  updated_at     TIMESTAMP
);

CREATE TABLE balance_prompts (
  prompt_id     TEXT PRIMARY KEY,
  user_id       TEXT,
  topic         TEXT,
  concentration REAL,                 -- % of recent consumption
  shown_at      TIMESTAMP,
  chosen        TEXT,                 -- null|stretch|stay
  chosen_at     TIMESTAMP
);

CREATE TABLE topics (
  id           TEXT PRIMARY KEY,
  label        TEXT,
  emoji        TEXT,
  search_terms TEXT,                  -- JSON array
  category     TEXT,
  age_gate     BOOLEAN DEFAULT 0,
  source       TEXT                   -- seed|user_added
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
  status        TEXT,                 -- active|expired|revoked
  created_at    TIMESTAMP
);

CREATE TABLE drift (
  user_id       TEXT,
  week          TEXT,                 -- ISO: "2026-W15"
  summary       TEXT,                 -- JSON
  calculated_at TIMESTAMP,
  PRIMARY KEY (user_id, week)
);

CREATE TABLE guard_eval (
  eval_id        TEXT PRIMARY KEY,
  request_id     TEXT,
  url            TEXT,
  gemma_verdict  TEXT,
  gemma_reason   TEXT,
  human_verdict  TEXT,                -- labelled by Steve
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

Deliberate, restrained, editorial. CSS custom properties consumed directly. No Tailwind, no CSS-in-JS, no Storybook.

### Fonts

- **Source Serif 4** — headlines, card titles, hook lines
- **DM Sans** — UI, labels, metadata

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
│   [image 16:9]         [🔖][✕] │   Icons top-right, small, --text-tertiary
│   [content type badge]          │   Top-left of image, semi-transparent
├─────────────────────────────────┤
│  [topic pill]  ·  [source]      │   DM Sans --text-xs, uppercase
│  Headline wraps to two lines    │   Source Serif 4 --text-lg
│  "Personal hook, one sentence." │   Source Serif 4 italic --text-base, --text-secondary
│  4 min  ·  2 hours ago          │   DM Sans --text-xs, --text-tertiary
└─────────────────────────────────┘
```

Tap targets 44×44 minimum despite small visual icons.

### Named motion

- Card tap — scale 1.0 → 0.97 → 1.0, ease-spring, 80ms/200ms
- Dismiss — fade to 0.3 over 200ms, slide up, next card rises
- Save — bookmark fills with accent pulse, 200ms ease-spring
- Page turn (magazine) — 350ms ease-in-out, slight parallax on image
- Cover splash — 600ms stagger, auto-transition
- `prefers-reduced-motion` — all animations disabled

### Frontend stack

React 18 + Vite · Framer Motion · Zustand · TanStack Query · Lucide · Radix primitives.

A single `/design-reference` route in the PWA shows every component in every state. Serves as the design doc.

---

## 17. Build plan

Nine phases. Sequential. Each ends with something the family uses.

- **Phase 0 ✅** — Foundation
- **Phase 1 ✅** — Request flow (videos download via Shortcut, play in PWA)
- **Phase 2 🔨** — The feed (in progress)
- **Phase 2.5** — Discovery engine
- **Phase 3** — The guard
- **Phase 4** — Sources & scoring (adult RSS/podcasts/papers)
- **Phase 5** — Drift
- **Phase 6** — Overrides & blocking (gated on partner)
- **Phase 7** — MCP
- **Phase 8** — Frontier escalation (optional)

### Phase 2 — The feed

Builds the timeline per Section 8. Today section renders **two** sub-groups: My requests, From your channels. "Picked for you" is stubbed / empty — populated in Phase 2.5.

- Card component, design tokens, named animations
- Timeline feed (reverse-chron, day-grouped, `added_at` anchor)
- Past days as unified lists, continuous scroll
- Three card states (live / recycled / gone), one-tap restore
- iPad layouts (two-column portrait, three-column landscape)
- iPhone magazine mode
- Inline video player (HTML5, full-screen, state machine)
- Watched indicator
- Saved tab (bottom nav, never recycled)
- Search via yt-dlp metadata + FTS5 over timeline
- Channel subscriptions (kids pick, RSS every 6h, pipeline-processed)
- Cover splash, topic filter, bottom nav
- `/design-reference` route

**Ends with:** a timeline PWA showing every card ever added, restore for recycled files, search across history. No automated guard yet.

### Phase 2.5 — Discovery engine

Spec in Section 9a. Two sessions.

- Three-layer profile model (behavioural signal capture, `re_watch_count`)
- `inferred_affinities` table, Gemma generates sentences from behaviour
- `candidate_pool` table
- Discovery sources: topic search, related-channel expansion
- Gemma scoring, batched
- Daily cap enforcement with surplus carry-forward
- "Picked for you" section in Today, with "That's it for today — more tomorrow"
- "Why this?" affordance on every discovery card
- Balance prompt (>70% concentration, max once per 1-2 weeks)
- Cold start handling
- BullMQ repeatable job, early morning on M4
- Cleanup job: prune unsurfaced candidates >30 days old

**Ends with:** Today's feed has a populated Picked for you section with visible reasoning, respecting the scarcity principle.

### Phase 3 — The guard

Spec in Section 9. 1-2 sessions.

- Gemma prompts for triage
- Eval set: 100 labelled examples per kid from real Phase 1-2 data
- Tune until thresholds hit (95% / 90% / 10-30%)
- Wire into request pipeline
- Uncertain → parent ntfy with approve/deny actions
- Appeal flow
- First month: parent reviews sample of clear-yes too

**Ends with:** ~70-80% of requests auto-handled, parents only see uncertain + appeals.

### Phase 4 — Sources & scoring

1 session.

- RSS ingestion (articles, podcasts, papers)
- Gemma scoring against profile + hook generation (batched)
- Unified feed rendering (video + article + podcast + paper cards)
- Dismiss/save/dwell signal capture

**Ends with:** adult feed is a proper daily read.

### Phase 5 — Drift

Spec in Section 10. 1 session.

- BullMQ repeatable Sunday evening job
- Kid view (no number), adult view, parent view
- Baseline period for first 3-4 weeks
- Tap-through to filtered timeline for evidence

**Ends with:** weekly literacy surface working.

### Phase 6 — Overrides & blocking

Spec in Section 11. 1-2 sessions. **Gated on partner buy-in.**

- Pi-hole Docker, configured but disabled
- Override lifecycle (request → grant → expiry)
- ntfy actions for parent approval (replaces "Web Push" — all notifications go through ntfy per Section 12)
- DNS-block landing page on Ubuntu nginx
- Go-live checklist

**Ends with:** DNS blocking live, landing page redirecting to Eddy.

### Phase 7 — MCP

Spec in Section 13. 1 session.

- MCP server module in M4 Node process
- All tools
- Privacy enforcement layer with integration tests
- Holiday mode

**Ends with:** Steve manages Eddy from Claude.ai in plain language.

### Phase 8 — Frontier escalation (optional)

Only if 6+ months of parent-decision data justifies it. Spec in Section 9.

---

## 18. Out of scope for v1

- Partner profile — added when she opts in
- TikTok replacement — blocked via Pi-hole, no pipeline
- Plex-to-Jellyfin migration
- Hosted / SaaS version
- Android support — household is iOS-only
- Fire OS / Fire Stick app — parent grants by local IP
- Kids' sources beyond video — after YouTube flow is bedded in
- Automated profile tuning from Drift signals — suggestions only, always manual apply

Native iOS app is explicit v2. See `docs/decisions.md`.

---

## 19. Open questions

Resolve before or during the relevant phase.

1. **Gemma inference throughput on M4 with 16GB RAM.** Can it handle scoring + hook generation + triage on a busy day without swap? Instrument in Phase 2.5/3, adjust batch sizes if needed.
2. **Whole-house DNS coverage (Phase 6 decision).** HH2 can't push DNS to DHCP clients. Tailscale-only may be sufficient once kids are using share-sheet for most requests. If not: Pi-hole-as-DHCP (fragile but free) or router replacement (~£140 for UniFi Cloud Gateway Ultra). Decide at start of Phase 6.
3. **Eddy domain name.** Registered or pending. Needed properly when native ships (for universal links — `.ts.net` can't serve `apple-app-site-association`). Current working DNS: `eddy.tail-xxxx.ts.net`.

### Known dependencies

- **ntfy.sh upstream** — required for instant iOS push (poll-request forwarding). Single point of failure outside our control. Uptime has been good. Native iOS (v2) removes this dependency.
- **yt-dlp + bgutil-ytdlp-pot-provider** — active arms race with YouTube. Both well-maintained, typical fix times 24-48h. Mitigation is operational (Section 6 Reliability). No credible architectural alternative.

---

## 20. Project identity

- **Name:** Eddy — a current that moves differently to the main flow
- **Weekly summary name:** Drift
- **Repo:** `eddy-hq/eddy`
- **Licence:** MIT
- **Open source:** when stable (post-Phase 5). Per-household native builds require per-household Apple Developer accounts — consistent with self-hosted ethos.