# Eddy — Implementation Document

**Status:** Phase 4 in progress. Phases 0–3 shipped. Feed, guard shadow mode, and RSS poller running. Search and people/follow flow in progress.

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

And there is a second shift happening underneath all of this. As AI-generated content volume goes vertical, the scarce resource stops being content and starts being *trusted human judgement*. People increasingly organise their media diet around specific humans whose taste they trust, not topics or platforms. Eddy is built for that shift.

### What Eddy is

A family media space that honours real requests, quietly removes engagement traps, and organises attention around the humans whose judgement is worth your time.

- **For kids** — a service that's on their side. Shared links come back watchable within minutes. Rejections come with reasons and an appeal path. They feel looked-after, not watched.
- **For adults** — a daily read. Articles, podcasts, papers, video, books, laid out like a magazine. No feed designed to keep them past what they came for.
- **For the household** — one place where media lives, one set of controls, managed in plain language.

### Four goods, in order

1. **Serve the real request.** If someone asks for something, the default is yes. The only reasons not to are concrete and visible.
2. **Replace the dopamine loop with something that earns its time.** No autoplay, no infinite scroll, no "you might also like" engineered to catch an impulse. Finishing the feed is a valid state.
3. **Route attention through humans, not algorithms.** Eddy organises subscriptions around people — not channels, not feeds, not topics. Following someone means following their output across media and (over time) the things they recommend. The algorithm's job is to route between people you trust and you, not to decide what's good.
4. **Build media literacy, not dependence.** Over a year, a kid using Eddy should understand more about who is shaping their attention than they did at the start. The long-term goal is children who grow up able to name the humans influencing their worldview, notice when those humans change, and choose deliberately.

### Non-negotiable rules

- **The kid's experience is never punitive.** Rejections come with reasons and an appeal path. Waiting is explained. Nothing is silent.
- **No surveillance surfaces on kids' screens.** Streaks and summaries exist to help the kid understand themselves. Person-level transparency for kids is qualitative and observational, never quantitative or ranked.
- **No automated recommendation without a visible reason.** Every suggested item shows, in one line, why.
- **Private by default.** Kids' consumption never leaves the house.
- **Infrastructure serves experience.** Blocker, guard, pipeline exist to deliver the four goods.

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
│    profiles · people · requests · sources · feed · guard     │
│    drift · overrides · notifications · mcp                   │
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

## 4a. People as the subscription unit

The subscription model in Eddy is built around **people**, not channels, shows, or feeds.

A *person* in Eddy is an identity — an individual creator, a duo, or a studio treated as a single entity. A person has one or more *outputs* they produce: a YouTube channel, a Substack, a podcast, books, a blog. Following a person subscribes you to all of their outputs in one action.

A person also has *recommendations* — things they've pointed at but didn't make. When someone you follow praises a book, links to an essay, or appears as a podcast guest, that pointer becomes a candidate for your feed with their name attached.

**Why people, not channels or feeds:**

Trusted human judgement is becoming the scarce resource (see Section 1). Organising around people makes the trust relationship the first-class concept, and the media types secondary. You follow Tyler Cowen; Eddy handles whether his latest output is a blog post, a podcast appearance, or a book — same subscription, different fetchers.

It also makes Eddy's reasoning honest. Gemma isn't deciding what's good; the people you've chosen to trust are. Gemma's job is routing between their output and you, filtered lightly for relevance.

**For adults,** a person usually has three or four outputs across media. Following Tyler means his blog, his podcast, his books, and the things he recommends.

**For kids in v1,** a person's outputs are effectively just a YouTube channel — a 10-year-old follows MrBeast, and under the hood it's a channel subscription. The data model is uniform across ages; the UI complexity for kids is deliberately thin. As a kid grows into other media, the infrastructure is already there.

Most YouTube channels a kid follows *are* a person — MrBeast, DanTDM, Dream. A few are collections (Dude Perfect, family channels). A `person_type` flag (individual, duo, group, studio) handles the distinction; mechanics don't change.

**Person-level transparency is a literacy tool.** Kids see: who they follow, when they started following, roughly how often they've engaged. Qualitative and observational ("you've been really into this creator lately") never quantitative and ranked ("Dream: 312 hours"). Adults see richer detail on their own following. The rule against surveillance surfaces on kids' screens applies.

Where the design calls for a channel, feed, or subscription in the rest of this document, the underlying unit is a person. An output (the actual RSS feed or channel) is an implementation detail.

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

**Safety net (Phase 9): DNS-block landing page.** Blocked YouTube domains resolve to a local page: *"Looks like you're trying to watch something. Open in Eddy?"* URL prefilled, one tap submits. Every block becomes a redirect, not a wall.

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

### New outputs from people you follow

Subscriptions are on *people* (Section 4a), not channels. For video specifically:

- Each person has zero or one YouTube channel as an output
- Every 6 hours, Eddy polls the channel RSS for each followed person
- New videos go through the same guard pipeline as requests
- For kids in v1, this is the dominant output type per person — a followed person is effectively their YouTube channel
- For adults, a person's YouTube channel is one output among several

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

### Tracking seen items per output

`seen_videos` table — `(output_id, video_id, seen_at)`. yt-dlp pulls channel RSS for each output; items already in `seen_videos` are skipped. The same pattern extends to non-video outputs (podcast episodes, Substack posts, etc.) via a generalised `seen_items` table keyed by output.

---

## 7. Sources beyond YouTube

Eddy handles multiple media types. All of them route through the same people-first subscription model (Section 4a) and the same discovery engine (Section 9a). Media type is a rendering concern, not a pipeline concern.

### Fetchers, not sources

Each output a person has is served by a *fetcher* — a small adapter that knows how to read that output's feed:

- **YouTube channel fetcher** — RSS → yt-dlp metadata
- **Podcast RSS fetcher** — standard podcast RSS
- **Substack / blog fetcher** — RSS, with full-text where the feed provides it
- **Podcast RSS fetcher** — episode metadata only, never audio
- **arXiv / PubMed fetcher** — RSS + API metadata
- **Book-recommendation detection** — Gemma reads a person's text output and extracts book mentions into `person_recommendations`

Adding a new fetcher is a new file, not a new system.

### Articles (adult feed primarily)

Cards link to original source. Safari Reader is the reading experience. Eddy is a pointer, not a reader. Dwell signal captured (tap + didn't-come-back-quickly).

Kids' article sources (BBC Newsround, Nat Geo Kids, etc.) added once the YouTube flow is bedded in.

### Recipes — partial extraction (schema.org only)

Food blogs are the one case where link-out is meaningfully worse than inline: the recipe is buried under 1500 words of personal essay, and the author has usually published the structured data themselves for Google.

Recipe extraction rules:

- Only when the page has `Recipe` schema.org JSON-LD
- Render the structured fields as the card interior: ingredients as a list, steps as a list, yield, timings
- No extraction of surrounding prose
- Link to original always available
- If no `Recipe` markup: link-out card, no extraction attempted

This pattern — "use the author's own structured data, fall back to link-out" — may extend to `Event`, `Product`, or `HowTo` markup in later phases if the need emerges. It is deliberately *not* general article extraction. The brief's "no scraping" position stands for everything else.

### Podcasts — discovery-only

Podcasts do not use the subscription model. Household members already use podcast apps (Apple Podcasts, Overcast); Eddy re-surfacing shows they already follow is noise.

Eddy's podcast value is finding single episodes worth your time from shows you *don't* follow — the gap podcast apps fail to address.

Mechanics:

- Per-user curated list of ~50 high-quality podcasts across their topics (seed + expand over time)
- Every 6 hours, Eddy polls each show's RSS for new episodes
- Gemma classifies each new episode against the user's profile using title, category, and show notes (three-bucket classification: clear-match / clear-reject / uncertain)
- Uncertain drops silently. A good episode Eddy missed is invisible; a bad episode surfaced erodes trust in "why this?"
- Clear matches flow to the discovery surface with a generated "why this?" line
- Tap → user's preferred podcast app (settings-configurable deep link, fallback to show's web page)

Where a guest is someone the user follows as a person (Section 4a), that's a heavy positive signal in scoring. Transcript-based deep scoring happens opportunistically for the subset of shows that publish transcripts — better signal when available, not required.

Every classification (match, reject, uncertain) is logged for evaluation. Same pattern as `guard_eval`.

No Shortcut path for podcasts. No podcast search-and-request. Episodes are ephemeral and discovered, not requested.

### Books

Books are a content type in Eddy, discovery-driven via people you follow (Section 4a).

Sources:

- **Explicit recommendations in a person's output** — Gemma detects book mentions in blog posts, Substack, show notes ("books I read this year", linked Amazon/Bookshop URLs, in-line praise)
- **Author-on-podcast signal** — when podcast discovery surfaces an episode, and the guest has a recent book, the book becomes a candidate with the episode as evidence
- **Crossover signal** — when multiple people a user follows point at the same book, score jumps

No book catalogue ingestion, no general book search, no Goodreads/Amazon feed polling. Discovery is driven entirely by *who recommended it*.

The book card shows: cover, title, author, recommender(s), one-line hook, length (pages or audiobook hours), "why this?" Tap → user-configurable destination (Amazon UK, Bookshop.org, library, Libby, Kindle).

Books have a read-state beyond the usual: `reading_status` — *want to read*, *reading now*, *finished*. A one-tap "did this land?" on finish captures signal for future recommendations.

Books live in the timeline like any other card. They also appear in a dedicated "Reading list" view alongside Saved, filtered by `reading_status`.

Kids do not get book discovery in v1. Kids' book discovery is a worthwhile later problem (Phase 12+).

### Papers

arXiv and PubMed via their RSS / API. Metadata and abstract only — the abstract becomes the card hook. Tap opens the PDF in Safari. Niche but directly serves adult AI/fitness/nutrition interests.

### Direct creator support (surfacing only)

Every person card shows their direct-support links: Substack subscription, Patreon, Amazon author page, Bookshop.org affiliate, Bandcamp, Ko-fi, etc.

Eddy surfaces these. Eddy does **not** process payments. The regulatory overhead of being a money transmitter is disproportionate for household scale, and creators already have payment infrastructure that works. The ethical signal ("Eddy makes the direct-support path visible") is captured without the operational cost.

Later phases may add a year-end "where did my attention go" view reflecting engagement back to the user with an invitation to allocate support. Still no payment processing in Eddy.

### What Eddy explicitly doesn't do for non-video content

- Eddy never hosts audio (podcasts, music). Deep-link to the user's real podcast app.
- Eddy never hosts article text (except schema.org-extracted recipes). Safari Reader is the reading experience for articles.
- Eddy never hosts books.
- Eddy never hosts video outside its own pipeline — no embedding third-party players.

Video is the only content type Eddy hosts locally, and only because the guard and file-state model require it.

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
│   From people you follow (new outputs from them)   │
│   Picked for you        (Phase 5 — discovery)      │
├─ Yesterday ────────────────────────────────────────┤
│   [unified list]                                   │
├─ Tuesday 8 April ──────────────────────────────────┤
│   [...continuous scroll back...]                   │
└────────────────────────────────────────────────────┘
```

**Today** is the only day with sub-sections — it's the only day still being written. Past days are unified lists.

**Continuous scroll only** in v1. Day headers separate sections. No date picker, no calendar, no time-jump.

### Card states

Three visual tiers reflecting file state (video only; other types skip this):

- **Live** — file on disk, immediately playable. Full colour.
- **Recycled** — record remains, file recycled. Dimmed thumbnail, restore icon. One tap re-downloads.
- **Gone** — YouTube removed. Heavily dimmed, "No longer available", offers find-similar.

Watched state is an additional overlay — tick + "Watched Xh ago" replacing duration.

### iPad layouts

More of the timeline visible at once is the goal.

- **Portrait (≥768px)** — two-column grid within each day
- **Landscape (≥1024px)** — three-column grid, left sidebar with topic filter and search

iPhone uses the same grid, denser. No magazine mode.

### Card component

Content type badge distinguishes video / article / podcast / paper / book / recipe.

Tap destinations:
- Video (live) → inline PWA playback, HTML5 full-screen
- Video (recycled) → restore → play
- Video (gone) → find similar
- Article → Safari
- Recipe (schema.org-extracted) → inline view, with original-source link
- Podcast → user's configured podcast app, fallback to browser
- Paper → Safari
- Book → user-configured destination (Amazon/Bookshop/library/Libby/Kindle)

Card shows: thumbnail, topic pill, source (person name where known), headline, one-sentence personal hook, duration/read time/page count. Past-day cards also show "Watched Xh later" if applicable.

### Personal hook

Every card has a hook line beneath the headline. Max 15 words, direct, specific not generic. Gemma-generated in batches (10-20 items per inference call). Falls back to one-line description if generation fails.

Where the "no recommendation without a visible reason" rule lives. Generic hooks ("you might like this") are a system failure and should fall back to description.

### Interactions

- **Tap** → open/play (or restore → play). Primary action.
- **🔖 Bookmark** → save for later. Small, top-right. Saved items immune to recycling.
- **✕ Dismiss** → card dims in place but stays in the timeline. First in line when recycling hits.
- **"Why this?"** (Phase 5+) → dedicated small affordance on discovery-surfaced cards. Shows reasoning in one sentence.
- **Long press** → more options (share, more like this).
- **Dwell** — IntersectionObserver tracks >5s visibility without dismiss as positive signal. Silent.

No swipe-as-primary. Dismissal is a quiet opt-out.

### Search

Full-text across the whole timeline via SQLite FTS5. Matches title, personal hook, person/channel, topic. Flat results list ordered by relevance, card's original date shown beneath. Also powers "find similar" for gone cards.

Text-only in v1. Filters (saved, person, date range, topic) come in a later polish pass.

### Saved and Reading list

Saved items appear in the timeline in original position *and* in a dedicated Saved tab. Saved tab is a forever list, reverse-chronological by save date. Saved items never recycled.

Books additionally appear in a Reading list view filterable by `reading_status`.

### New-content entry points

Separate from the timeline — how content *enters* the system:

- **Video search** — yt-dlp metadata search. Type query, see titles/channels/durations/thumbnails, tap request.
- **Person search** — add a person to follow. User searches by name; Eddy proposes candidate outputs (YouTube channel, Substack, podcast) and the user confirms which to subscribe to. Parent-approved for kids, auto-approved for adults.

---

## 9. The guard

Gemma 4 E4B as triage, parent as adjudicator. Frontier model as optional future middle-tier (Phase 11).

### Three outcomes

For every kid request (Shortcut, output drop, search-and-request):

- **Clear-yes** → approve, queue download
- **Clear-no** → reject with one-sentence reason + appeal button
- **Uncertain** → escalate to parent via ntfy. Kid sees "waiting for a grown-up."

### Signals Gemma considers

- Title, channel, description
- Auto-generated transcript (when available)
- Person / channel reputation (past approvals/rejections in SQLite)
- Keyword hard-exclusions from kid's profile
- Age-appropriate framing for kid's age

### Evaluation

Eval set is built from real household traffic in Phase 3 (shadow mode), not in a separate labelling exercise. Gemma scores every request from Phase 3 onward; Steve labels verdicts periodically via CLI. By Phase 6, hundreds of labelled decisions across real requests exist.

Tune Gemma until:

- **Clear-yes precision ≥95%** — false yes = unsafe content reaching kid
- **Clear-no precision ≥90%** — false no = good content wrongly rejected
- **Uncertain rate 10-30%** — higher = parent overload, lower = overconfident

Phases 3–5 run shadow mode: Gemma scores, verdicts are logged, downloads auto-approve regardless. Phase 6 flips the default once thresholds hit. First month after go-live, parent reviews a sample of clear-yes decisions too via the admin surface.

### Frontier escalation (Phase 11, optional)

Once ~200 parent decisions from Phase 6 are in SQLite, evaluate whether Claude API calls on uncertain cases reliably match parent judgement. If yes, route uncertain → Claude API → if still uncertain → parent.

### Appeals

Every reject shows reason + one-tap "Ask a grown-up" button. Parent sees URL, Gemma's reasoning, approve/deny. Appeal decisions feed back into the eval set.

---

## 9a. Discovery and profile

Eddy proactively finds content worth surfacing. Small number of genuinely good picks per day, not an endless feed. Scarcity is a feature.

### Profile: four layers

**Layer 1 — Explicit.** Topics with weights, followed people (Section 4a), hard exclusions (kids' invisible to them), duration preferences.

**Layer 2 — Behavioural.** Completion rate per topic/person/duration-band, save rate, dwell-before-dismiss, re-watch count, requested-and-finished rate.

**Layer 3 — Person-level trust.** Per-person trust weights inferred from engagement. Completing most of a person's outputs across media → high trust. Dismissing consistently → low trust. Drives heavy scoring input.

**Layer 4 — Inferred affinities.** Gemma-generated sentences describing shape of preference: *"Likes long-form technical explainers, not short listicles."* Internal only v1 — not exposed in UI. Kids see Layer 4 indirectly via "why this?" on picks.

### "Why this?"

Every item surfaced by discovery (not requests, not direct outputs from people you follow — those are self-explanatory) has a small "why this?" affordance. Tap to see a user-appropriate one-sentence explanation.

Where a followed person is involved, the reasoning routes through them wherever possible:

Adult: *"Tyler recommended this book twice in the last six months, and it's on a topic you've been reading about."*

Kid: *"DanTDM doesn't usually make redstone videos, but this one's exactly the kind of thing you finished last week."*

If Gemma can't explain why, the item doesn't surface.

### Discovery sources

v1 (Phase 5):

- **New outputs from people you follow** — their YouTube uploads, Substack posts, podcast appearances, book releases. Strongest signal.
- **Recommendations from people you follow** — Gemma detects pointers in their text output (book mentions, linked essays), surfaces as candidates with recommender attribution.
- **Topic search** — daily `ytsearch20:'topic keywords'` for top-weighted topics. Used when person-sourced candidates are thin.
- **Related-people expansion** — from engaged items, identify adjacent people (guests, collaborators, frequently-mentioned). Candidates for suggesting new follows, not for direct surfacing without confirmation.
- **Podcast discovery** — episode-level scoring across a curated per-user podcast list (Section 7).

v2 deferred:
- Curated external lists (Reddit, HackerNews, Awesome-X repos). Ship without; add if discovery quality proves thin.
- Social signal (Twitter/X posts by followed people, shared links).

**Not using:** YouTube Data API. Keeps discovery yt-dlp-only, avoids Google Cloud entanglement.

### The engine

Daily BullMQ job, runs early morning so Today is populated by breakfast:

```
For each active user:
  1. Refresh candidate pool
       - Pull new outputs from followed people
       - Scan followed people's text outputs for recommendations
       - Run topic searches for top-N topics (fill gaps)
       - Poll curated podcast list
       - Dedupe against seen_items and content_items
  2. Score candidates with Gemma
       - Batches of 10-20
       - Person-trust-weight × relevance × quality × freshness
       - Reject dismissed-pattern matches, blocked people, hard-exclusions
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

Kids see: their own topics/people followed/durations, watch history via timeline, "why this?" on every surfaced item, balance prompts.

Person-level observation for kids is qualitative: *"You've been really into this creator lately."* Never quantitative or ranked.

Kids don't see: hard exclusions (gaming risk), parent-only notes, raw confidence numbers, full Gemma reasoning on clear-no rejections, pipeline/queue internals, cross-person hour tallies.

Adults see everything about their own profile. Parents see full detail of kid profiles except real-time viewing (that would be surveillance).

### Cold start

First 3-4 weeks, behavioural signal is thin. "Picked for you" shows *"Eddy is still figuring out what you like — tell it more"* with a prompt to follow people and rate. Aligns with Drift's "Getting to know you" baseline.

### Topics

Topics are named interests with a set of yt-dlp search strings. The `search_terms` JSON array is what does the work — `ytsearch20:'minecraft redstone tutorial'` runs daily as a gap-filler when person-sourced candidates are thin. The label and emoji are purely display.

**Two sources:**

**Seed list (`source = 'seed'`)** — a static JSON file shipped as a DB migration at Phase 5. Aim for 60–80 topics grouped by category:

| Category | Examples |
|---|---|
| Gaming | Minecraft, Roblox, Pokémon, Zelda |
| Sport | Football, Running, Cycling, Tennis |
| Science | Space, Biology, Physics, Chemistry |
| Tech | Programming, AI, Electronics |
| Arts | Drawing, Music production, Photography |
| Food | Cooking, Baking |
| Fitness | Gym, Yoga, Martial arts |

Age-gate anything warranting it (combat sports, some political commentary). The `age_gate` flag means it never surfaces in a kid's topic picker. The seed list doesn't need to be exhaustive on day one — `user_added` is the safety valve.

**User-added (`source = 'user_added'`)** — user types a topic Eddy doesn't have. One Gemma call generates the `search_terms` array. Prompt: *"Generate 4 YouTube search queries that would find good videos about {topic}. Return a JSON array only."* Store and treat identically to seed topics from that point.

**Onboarding topic picker:** On first setup, show a categorised pill grid — topics grouped by category, scrollable. Kids see age-appropriate categories; adults see the full set. Tap to add; weight defaults to `1.0`. Minimum viable onboarding: ≥1 topic and ≥1 followed person. Without both, discovery has nothing to work with.

**Channel → topic inference (Phase 5):** When a user subscribes to a channel, Gemma reads the channel description and recent titles and suggests 1–2 existing topics to link to it. This is a mapping from `channel_id` to existing `topic_id` — not topic creation. Behavioural weight flows from there naturally.

---

## 10. Drift — the literacy surface

Weekly. Not a score to optimise. A mirror to read.

### For kids

Every Sunday evening, Eddy generates a one-page summary:

- **How you spent your time this week** — topic breakdown, visual bars
- **Who you spent it with** — people you followed and engaged with, qualitative
- **What you kept watching** — completion rate, favourites
- **What you asked for and got** — requested vs pipeline-surfaced
- **One observation** — Gemma-written sentence: *"You watched a lot of Minecraft tutorials this week and finished most of them — looks like you're learning something specific."*

No number. No target. No week-on-week comparison. Optional streak counter tracks *topic diversity*, not volume.

Each row taps through to a filtered timeline view of the evidence. Drift is a guided tour of the week the kid can already see.

Observations may reference inferred affinities or person-level patterns: *"You finished all five redstone tutorials Eddy picked this week — looks like that hunch was right."* or *"You started watching a new creator this week — how's that going?"* The feedback loop is visible.

### For parents

Same data, richer view:
- All kid-facing signals
- Request approval/rejection summary
- People trending up/down
- Profile adjustment candidates — *"Son 1 dismissed 8/10 football videos this week; suggest reducing football weight?"* Never auto-applied.
- Red-flag surface (sharp diversity drop, late-night request spike) as a quiet notification, not a push

### Adult Drift

Same mechanic applied to own consumption. No one else sees it.

### Baseline

First 3-4 weeks per user shows "Getting to know you" instead of Drift content.

---

## 11. Overrides & blocking (Phase 9, gated)

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
- `eddy-boy1-{uuid}`
- `eddy-boy2-{uuid}`

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
| `get_followed_people` / `follow_person` / `unfollow_person` | Manage people subscriptions |
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
| Adult profile topics and followed people | ✓ | ✓ |
| Adult Drift summary | ✓ | ✓ |
| System status, queue depth | ✓ | ✓ |

No automated external calls in v1. Claude API usage (Phase 11, optional) requires explicit config and logs every call.

---

## 15. Data model

SQLite, single file on M4, nightly backup to Ubuntu. All tables have `user_id` where relevant.

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

-- People as the subscription unit (Section 4a)

CREATE TABLE people (
  person_id     TEXT PRIMARY KEY,
  display_name  TEXT,
  person_type   TEXT,                -- individual|duo|group|studio
  photo_url     TEXT,
  bio           TEXT,
  support_urls  TEXT,                -- JSON: {substack, patreon, bookshop, etc.}
  created_at    TIMESTAMP
);

CREATE TABLE person_outputs (
  output_id     TEXT PRIMARY KEY,
  person_id     TEXT,
  output_type   TEXT,                -- youtube|podcast|substack|blog|arxiv|author
  fetcher_type  TEXT,                -- which fetcher adapter handles this
  feed_url      TEXT,                -- RSS URL, channel ID, etc.
  external_id   TEXT,                -- e.g. YouTube channel ID
  active        BOOLEAN DEFAULT 1,
  last_polled   TIMESTAMP
);

CREATE TABLE followed_people (
  user_id       TEXT,
  person_id     TEXT,
  trust_weight  REAL DEFAULT 1.0,    -- Layer 3 of profile
  followed_at   TIMESTAMP,
  followed_via  TEXT,                -- manual|suggestion|guest_crossover
  PRIMARY KEY (user_id, person_id)
);

CREATE TABLE person_recommendations (
  rec_id        TEXT PRIMARY KEY,
  person_id     TEXT,                -- who made the recommendation
  content_type  TEXT,                -- book|article|podcast|video|paper
  target_url    TEXT,
  target_title  TEXT,
  target_author TEXT,                -- for books etc.
  source_output_id TEXT,             -- which output carried the recommendation
  framing       TEXT,                -- the recommender's own words, where extractable
  detected_at   TIMESTAMP
);

-- Requests (kid-initiated, share-sheet flow)

CREATE TABLE requests (
  request_id       TEXT PRIMARY KEY,
  user_id          TEXT,
  source           TEXT,              -- share_sheet|search|output_drop|dns_landing
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
  content_type     TEXT,              -- video|article|podcast|paper|book|recipe
  title            TEXT,
  person_id        TEXT,              -- attributed to a person where known
  source_output_id TEXT,              -- which output produced this
  recommender_id   TEXT,              -- person_id who recommended, if applicable
  author           TEXT,              -- for books, papers
  url              TEXT,
  topic            TEXT,
  score            REAL,
  personal_hook    TEXT,              -- Gemma-generated, <=15 words
  why_this         TEXT,              -- Gemma reasoning for discovery picks
  thumbnail_url    TEXT,
  duration_secs    INTEGER,           -- video, podcast
  page_count       INTEGER,           -- books
  file_path        TEXT,              -- null when recycled or non-video
  nginx_url        TEXT,              -- null when recycled or non-video
  file_state       TEXT DEFAULT 'na', -- live|recycled|gone|na (non-video)
  added_section    TEXT,              -- my_request|from_people|recommendation
  discovery_source TEXT,              -- null|person_output|person_recommendation|topic_search|related_person
  structured_data  TEXT,              -- JSON for schema.org-extracted types (recipes)
  tapped           BOOLEAN DEFAULT 0,
  saved            BOOLEAN DEFAULT 0,
  dismissed        BOOLEAN DEFAULT 0,
  completed        BOOLEAN DEFAULT 0,
  reading_status   TEXT,              -- books only: want|reading|finished
  landed           TEXT,              -- books only: yes|no|null after finish
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
  title, personal_hook, author, topic,
  content='content_items', content_rowid='rowid'
);

CREATE TABLE candidate_pool (
  candidate_id     TEXT PRIMARY KEY,
  user_id          TEXT,
  content_type     TEXT,
  url              TEXT,
  external_id      TEXT,              -- youtube_id, episode guid, etc.
  title            TEXT,
  person_id        TEXT,
  recommender_id   TEXT,
  discovery_source TEXT,              -- person_output|person_recommendation|topic_search|related_person|podcast_scan
  discovered_at    TIMESTAMP,
  scored_at        TIMESTAMP,
  score            REAL,
  surfaced         BOOLEAN DEFAULT 0,
  surfaced_at      TIMESTAMP,
  rejected         BOOLEAN DEFAULT 0,
  rejection_reason TEXT
);

CREATE TABLE podcast_scoring_log (
  log_id        TEXT PRIMARY KEY,
  user_id       TEXT,
  episode_url   TEXT,
  show_name     TEXT,
  episode_title TEXT,
  verdict       TEXT,                 -- match|reject|uncertain
  reason        TEXT,
  scored_at     TIMESTAMP
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
  eval_id            TEXT PRIMARY KEY,
  request_id         TEXT,
  url                TEXT,
  gemma_verdict      TEXT,                -- clear_yes|clear_no|uncertain
  gemma_reason       TEXT,
  gemma_confidence   REAL,                -- 0.0–1.0
  prompt_version     TEXT,                -- tag, so verdicts are attributable to a prompt
  scored_at          TIMESTAMP,
  human_verdict      TEXT,                -- labelled by Steve; null until reviewed
  human_notes        TEXT,
  human_labelled_at  TIMESTAMP            -- null until reviewed
);

CREATE TABLE used_tokens (
  token_hash TEXT PRIMARY KEY,
  handler    TEXT,
  user_id    TEXT,
  used_at    TIMESTAMP
);

CREATE TABLE seen_items (
  output_id   TEXT,
  external_id TEXT,                   -- video ID, episode guid, post slug, etc.
  seen_at     TIMESTAMP,
  PRIMARY KEY (output_id, external_id)
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
│  [topic pill]  ·  [person]      │   DM Sans --text-xs, uppercase
│  Headline wraps to two lines    │   Source Serif 4 --text-lg
│  "Personal hook, one sentence." │   Source Serif 4 italic --text-base, --text-secondary
│  4 min  ·  2 hours ago          │   DM Sans --text-xs, --text-tertiary
└─────────────────────────────────┘
```

Tap targets 44×44 minimum despite small visual icons.

### Person card

People are a first-class surface. Following someone, tapping their name on a content card, or browsing "people you follow" all land on a person view:

- Photo, name, bio (one sentence)
- Outputs list (each tappable to filter feed to just that output)
- Recent items surfaced from them
- Direct-support links (see Section 7)
- Follow / unfollow action

Person cards are simple; the value is routing, not content.

### Named motion

- Card tap — scale 1.0 → 0.97 → 1.0, ease-spring, 80ms/200ms
- Dismiss — fade to 0.3 over 200ms, slide up, next card rises
- Save — bookmark fills with accent pulse, 200ms ease-spring
- `prefers-reduced-motion` — all animations disabled

### Frontend stack

React 18 + Vite · Framer Motion · Zustand · TanStack Query · Lucide · Radix primitives.

A single `/design-reference` route in the PWA shows every component in every state. Serves as the design doc.

---

## 17. Build plan

Eleven phases. Sequential. Each ends with something the household uses — for the family, or for Steve as the person tuning the system.

A session is a focused working block of a few hours ending with the system runnable, committable, typecheck/lint/tests green. Estimates below are rough and will shift as reality lands.

- **Phase 0 ✅** — Foundation
- **Phase 1 ✅** — Request flow
- **Phase 2 ✅** — Feed (core)
- **Phase 3 ✅** — Guard in shadow mode
- **Phase 4 🔨** — Channels, subscriptions, search
- **Phase 5** — Discovery
- **Phase 6** — Guard live
- **Phase 7** — Adult sources
- **Phase 8** — Drift
- **Phase 9** — Overrides & blocking (gated on partner buy-in)
- **Phase 10** — MCP
- **Phase 11** — Frontier escalation (optional)

### Phase 0 ✅ — Foundation

Monorepo, TypeScript strict, two Node entry points (M4 API, Ubuntu worker), shared modules, SQLite bootstrap, BullMQ + Redis, ntfy self-hosted, HMAC-auth'd internal callback, `.env` validation, Tailscale wiring end-to-end.

### Phase 1 ✅ — Request flow

Kid shares a YouTube link via iOS share sheet → Shortcut POSTs to M4 → job enqueued → Ubuntu worker pulls, yt-dlp downloads to `/mnt/ssd/eddy/videos/` → callback to M4 marks ready → kid gets ntfy → opens PWA, plays.

No feed yet. No guard — everything auto-approves. Signed-token pattern in place for notification actions.

### Phase 2 ✅ — Feed (core)

Spec in Section 8. ~3-4 sessions.

- Card component + design system (tokens, spacing, typography, state colours)
- Timeline view — every card ever added, reverse-chronological, day-grouped on `added_at`
- Three card states: live / recycled / gone, with one-tap restore
- iPad layouts (two-column portrait, three-column landscape). iPhone uses the same grid, denser. No magazine mode.
- Inline HTML5 player, full-screen, state machine
- Watched indicator
- Saved tab (bottom nav, never recycled)
- Topic filter (flat list)
- Bottom nav
- `/design-reference` route

Default-allow pipeline: every request auto-approves and downloads. `requests.status` and `requests.decided_by` fields exist but `decided_by` is always `auto_approve`. Schema is correct for Phase 3 onward; no retrofit needed.

No channels, no subscriptions, no search, no discovery, no guard. Those are later phases.

**Ends with:** a timeline PWA showing every card ever added, restore for recycled files. Kids request, it appears, they watch it.

### Phase 3 — Guard in shadow mode

Spec in Section 9. ~2 sessions.

Gemma scores every request. Verdicts are logged, not acted on. Downloads still auto-approve. The purpose of this phase is to build an eval set from real household traffic before putting Gemma in the critical path.

- `guard_eval` table populated on every request (see Section 15)
- Guard runs **before download** — same position it'll occupy in Phase 6, so Phase 6 is a default flip not a refactor
- Prompt designed properly now, not as throwaway scaffolding. Phase 6 tunes against the dataset Phase 3 builds, so the prompt needs to be close to the one that ships.
- CLI labelling tool (`npm run label-guard`): iterates unlabelled verdicts, shows URL + title + channel + Gemma's verdict + reasoning, accepts `a`/`d`/`s`/`q`. If disagree, follow-up for correct verdict. Writes `human_verdict` and `human_labelled_at`.
- No kid-facing change. No parent ntfy. No review surface. Downloads still auto-approve regardless of verdict.

**Ends with:** every request scored by Gemma. Steve labels verdicts periodically via CLI. After a few months, a real eval set exists. Family sees no change.

### Phase 4 — Channels, subscriptions, search

Specs in Sections 4a and 8. ~3 sessions.

- `people`, `person_outputs`, `followed_people` tables (kids' v1: one YouTube channel = one person)
- Person search + follow flow
- RSS polling per followed channel, 6h interval
- New channel outputs flow through the same request pipeline — including the shadow guard, so channel-originated items contribute to the eval set
- Today's feed gains a "From people you follow" section
- Full-text search via FTS5 over titles, personal hooks, person names, topics
- Search UI in the PWA

**Ends with:** kids follow channels, new videos appear automatically, search works across the whole library.

### Phase 5 — Discovery

Specs in Sections 4a and 9a. ~2-3 sessions.

- `person_recommendations`, `candidate_pool`, `inferred_affinities` tables
- Four-layer profile (behavioural signal capture, per-person trust weights, inferred affinities)
- Discovery sources: new outputs from people followed, recommendations extracted from their text outputs, topic search (gap-filler), related-people expansion (for follow suggestions, not direct surfacing)
- Gemma scoring with person-trust-weight as primary input, batched
- Shadow guard continues to run on discovered items the same way it runs on requested items
- Daily cap enforcement with surplus carry-forward
- "Picked for you" section in Today, with "That's it for today — more tomorrow"
- "Why this?" affordance on every discovery card, naming a specific person where possible
- Balance prompt (>70% concentration, max once per 1-2 weeks)
- Cold start handling
- BullMQ repeatable job, early morning on M4
- Cleanup job: prune unsurfaced candidates >30 days old
- Seed topics JSON → DB migration (~60–80 topics, categorised, age-gated where needed)
- Onboarding topic picker (categorised pill grid, ≥1 topic + ≥1 person required to proceed)
- User-added topic flow (Gemma generates `search_terms` from free-text input)
- Channel → topic inference on subscribe

**Ends with:** Today has a populated "Picked for you" with visible reasoning, mostly naming a specific person. Adults can follow across media types; kids follow people via YouTube channels (v1). Scarcity principle honoured. Guard still shadow-mode.

### Phase 6 — Guard live

Spec in Section 9. ~2 sessions.

By now the eval set from Phases 3–5 is substantial. This phase puts the guard in the critical path.

- Tune prompts against the labelled dataset until thresholds hit (95% clear-yes precision, 90% clear-no precision, 10–30% uncertain rate)
- Flip `decided_by` default: clear_yes auto-approves, clear_no auto-rejects with reason, uncertain escalates
- `/admin/guard-review` surface — lists uncertain items plus recent clear-yes/clear-no for spot-checking, one-tap labelling continues to feed the eval set
- Parent ntfy for uncertain verdicts with approve/deny actions (signed-token pattern)
- Appeal flow — kid taps "ask again" on a rejection, Gemma re-evaluates with the appeal context, still-uncertain escalates to parent
- Kid-facing rejection reasons (age-appropriate phrasing, not raw Gemma output)
- First month: parent reviews a sample of clear-yes too via admin view

**Ends with:** ~70–80% of requests auto-handled. Parents only see uncertain + appeals. Rejection paths exist with reasons and appeals.

### Phase 7 — Adult sources

Specs in Sections 7 and 9a. ~2-3 sessions.

- Generalised fetcher interface; adapters per output type
- RSS ingestion for articles, papers (arXiv/PubMed), Substack/blogs
- Podcast discovery engine (per-user curated show list, episode-level Gemma scoring, three-bucket classification, `podcast_scoring_log`)
- Book content type: recommendation detection in followed people's text outputs, author-from-podcast signal, crossover scoring, reading list view, `reading_status` and `landed` fields
- Recipe extraction (schema.org JSON-LD only) — structured card interior, fall-through to link-out
- Direct-support link surfacing on person cards
- Unified feed rendering (video + article + podcast + paper + book + recipe cards)
- Dismiss/save/dwell signal capture across all types

**Ends with:** adult feed is a proper daily read across all media types, driven by people you follow and their recommendations. Partner can get a real cooking + travel feed. Kids unchanged (video-only, channel-as-person).

### Phase 8 — Drift

Spec in Section 10. ~1 session.

- BullMQ repeatable Sunday evening job
- Kid view (no number, qualitative person observations), adult view, parent view
- Baseline period for first 3-4 weeks
- Tap-through to filtered timeline for evidence

**Ends with:** weekly literacy surface working for all household members.

### Phase 9 — Overrides & blocking

Spec in Section 11. ~1-2 sessions. **Gated on partner buy-in.**

- Pi-hole Docker, configured but disabled
- Override lifecycle (request → grant → expiry)
- ntfy actions for parent approval
- DNS-block landing page on Ubuntu nginx
- Go-live checklist

**Ends with:** DNS blocking live, landing page redirecting to Eddy.

### Phase 10 — MCP

Spec in Section 13. ~1 session.

- MCP server module in M4 Node process
- All tools including people management
- Privacy enforcement layer with integration tests
- Holiday mode

**Ends with:** Steve manages Eddy from Claude.ai in plain language.

### Phase 11 — Frontier escalation (optional)

Only if 6+ months of parent-decision data from Phase 6 justifies it. Spec in Section 9.


---

## 18. Out of scope for v1

- Partner profile — added when she opts in
- TikTok replacement — blocked via Pi-hole, no pipeline
- Plex-to-Jellyfin migration
- Hosted / SaaS version
- Android support — household is iOS-only
- Fire OS / Fire Stick app — parent grants by local IP
- Kids following people across media (v1 = YouTube channel per person); kids' book discovery; kids' non-video sources generally — after YouTube flow is bedded in
- Automated profile tuning from Drift signals — suggestions only, always manual apply
- Direct payment processing in Eddy (surfacing support links only — see Section 7)
- General article extraction beyond schema.org recipes
- Book catalogue ingestion or general book search (discovery via followed people only)
- Annual support-allocation/budget view (tempting, deferred)

Native iOS app is explicit v2. See `docs/decisions.md`.

---

## 19. Open questions

Resolve before or during the relevant phase.

1. **Gemma inference throughput on M4 with 16GB RAM.** Can it handle scoring + hook generation + triage + recommendation detection on a busy day without swap? Instrument in Phase 3, adjust batch sizes if needed.
2. **Whole-house DNS coverage (Phase 9 decision).** HH2 can't push DNS to DHCP clients. Tailscale-only may be sufficient once kids are using share-sheet for most requests. If not: Pi-hole-as-DHCP (fragile but free) or router replacement (~£140 for UniFi Cloud Gateway Ultra). Decide at start of Phase 9.
3. **Eddy domain name.** Registered or pending. Needed properly when native ships (for universal links — `.ts.net` can't serve `apple-app-site-association`). Current working DNS: `eddy.tail-xxxx.ts.net`.
4. **Recommendation detection quality.** Gemma extracting book/article/podcast recommendations from a person's text output is the novel piece in Phase 5/7. Signal quality unknown until tested on real data. If poor, fall back to "new outputs only" for followed-person discovery and revisit.
5. **Kid person-level UI tone.** "You've been really into this creator lately" is the intended register. Exact phrasing matters — reviewing with kids during Phase 5 is part of the work, not an afterthought.

### Known dependencies

- **ntfy.sh upstream** — required for instant iOS push (poll-request forwarding). Single point of failure outside our control. Uptime has been good. Native iOS (v2) removes this dependency.
- **yt-dlp + bgutil-ytdlp-pot-provider** — active arms race with YouTube. Both well-maintained, typical fix times 24-48h. Mitigation is operational (Section 6 Reliability). No credible architectural alternative.

---

## 20. Project identity

- **Name:** Eddy — a current that moves differently to the main flow
- **Weekly summary name:** Drift
- **Repo:** `eddy-hq/eddy`
- **Licence:** MIT
- **Open source:** when stable (post-Phase 8). Per-household native builds require per-household Apple Developer accounts — consistent with self-hosted ethos.