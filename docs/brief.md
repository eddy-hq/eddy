# Eddy — Implementation Document

**Status:** Phases 0–5 shipped (feed, guard shadow mode, RSS poller, channel follow, search, discovery). Discovery engine, interest picker, balance prompts, channel→interest inference, profile-editing surface (Interests + People), freeform-interest input, person bio/photo capture, topic→interest schema rename, "why this?" hard filter plus inline explanation, and kid interest-add through the guard are all live. Recommendation extraction and related-people expansion are deferred to Phase 7. Phase 6 (guard live) is next.

Load-bearing decisions live in `docs/adr/`; prose-form design rationale lives in `docs/design-notes.md`; domain vocabulary lives in `CONTEXT.md`. This document is the spec.

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

**2012 Mac Mini (16GB i7, Ubuntu Server 24.04, Ethernet next to router)** — existing Plex + arr stack (untouched by Eddy). Adds: download worker, Redis, nginx, Pi-hole (later).

**Storage on Ubuntu:**
- HDD — existing Plex library, untouched
- SSD — `$VIDEO_OUTPUT_PATH` for video files, `$THUMB_OUTPUT_PATH` for selected thumbnails (see `.env.example`). Eddy owns. yt-dlp writes, Eddy recycles, Plex and nginx read.

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
- `https://eddyhq.app/feed` — PWA
- `eddy://feed` — native shell (Section 21)

Same paths both forms. Switching consumers is a protocol prefix change, not a route rewrite. Custom scheme only — universal links would need a publicly reachable `apple-app-site-association`, and `eddyhq.app` is tailnet-only.

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
2. `POST [base]/requests` with the URL — responds `202` with `{ requestId, status, message, pwaUrl }`. `message` is the kid-facing confirmation (*"Got it, Boy1. Working on it."*); `pwaUrl` is an absolute link to the user's feed
3. `Open URL pwaUrl`

`[base]` is a Shortcut variable. Today: `https://eddyhq.app`. The native shell replaces this route with a real share extension and keeps an App Intent for anyone who prefers the Shortcut (Section 21).

The share extension uses the same endpoint and the same response, and needs nothing more from it: it shows `message` inline in the share sheet and dismisses — the kid stays in YouTube, which is the point. It never opens a URL, so there is no per-request landing route and none is planned. `pwaUrl` exists only for the Shortcut (it is an absolute LAN address, which a client-agnostic API shouldn't hand out) and is removed when the Shortcut is retired.

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
Parent approve/deny via notification (if escalated)
        ↓
Download → $VIDEO_OUTPUT_PATH/{youtube_id}.mp4, H.264
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
  -o $VIDEO_OUTPUT_PATH/{id}.mp4 \
  {url}
```

Flag notes: `mweb` client is the path the plugin supports. Sleep intervals keep us polite and avoid rate-limiting. H.264 + AAC forced — ffmpeg stream-copies only, no re-encode (verify with `--verbose` that both streams show `(copy)`). Concurrent fragments give 2-3× throughput. `--no-part` skips a rename step on local disk.

Metadata and auto-subs stored in SQLite for guard + hook generation.

### Thumbnails — frame selection, not stylisation

YouTube's creator-uploaded thumbnails are often the most clickbaity surface on the platform — title-card text, exaggerated faces, saturated graphics. Earlier exploration considered a sharp pipeline (blur + desaturate + dim) to neutralise them; that was rejected. Blurred thumbnails read as broken, and the editorial register the rest of the design aims at depends on *high-quality* imagery, not muted imagery.

Instead, after each successful download the Ubuntu worker picks a thumbnail in a separate queue (Gemma runs on the M4, reached through signed `/internal/thumb/*` endpoints). Until it has, the card shows a neutral placeholder — never the unchecked creator thumbnail.

**Safety floor.** Every image the picker would show — the creator thumbnail, a YouTube auto-frame, or an ffmpeg-sampled frame — is first scored by Gemma 4 E4B (vision, structured output, `thumb-safety-v1`) on the rubric's Violence, Frightening and Sexual dimensions (0–3, anchors from `docs/guard-rubric.md`). Any score above 1 rejects the image and the picker moves to the next candidate; a scorer error or malformed reply is a reject, never a pass. At most four safety checks run per video; once they're spent the picker stops.

Every winner is saved as `$THUMB_OUTPUT_PATH/{youtube_id}.webp` and served by nginx — YouTube images included, downloaded and converted by the worker before they are checked — so the bytes checked are the bytes shown. Serving an i.ytimg.com URL would let a creator swap the image after it passed.

1. **Creator thumbnail, if editorial and safe.** Gemma classes the creator thumbnail editorial or slop (a style judgement). An editorial one is kept if it passes the floor.
2. **YouTube auto-frames.** YT exposes algorithmically-chosen frames per video (`hq1`/`hq2`/`hq3`, served at `maxres1–3` where they exist). The first classed editorial that passes the floor wins.
3. **Local ffmpeg frames.** The worker extracts 3 frames from the video file (`30%`, `50%`, `70%` of duration), Gemma scores their composition 0–10, and the best-composed frame that passes the floor wins. An existing local frame from an earlier run is re-checked, not trusted.
4. **Neutral placeholder.** If nothing passes, the card gets a plain dark placeholder — an inline SVG data URI, so it needs no file or nginx and can't go missing — never the creator thumbnail. The thumbnail is never left null, because the PWA fills a null with the creator's image.

Each video's outcome (which slot won, safety checks run and rejected, per-dimension scores) is logged by the worker and M4 without titles or model reasons. Code: `src/workers/thumb.ts`, scorer in `src/modules/guard/thumb-safety.ts`.

Known gap: the Plex poster is still set to the creator thumbnail at download and isn't updated by the picker.

Thumbnails persist across file recycling so "recycled" cards stay recognisable.

### No Google credentials in the kids' path

Kids download anonymously. No cookies, no account. Age-restricted and members-only content fails — that's the right outcome for kids, turned into a kid-readable rejection with appeal. An adult code path with throwaway-account cookies may come later for adult-only downloads.

### Queue configuration

- Concurrency 2 on the Ubuntu worker
- Retries 3× with exponential backoff
- Job payload: URL, youtube_id, user_id, destination filename. No binary data on the queue.

### Plex integration

- Library type "Other Videos" (no agent matching) pointing at `$VIDEO_OUTPUT_PATH`
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

- Per-user budget first (configurable, default 100 GiB per user). The nightly pass picks victims from users over budget until they're back under. Not time-based.
- Global hard cap as a second guard (configurable, default 350 GiB total). After the per-user sweep, if the global live total is still over the cap, the same priority order recycles further victims across all users.
- Priority order (first-to-recycle → last):
  1. Dismissed items, oldest by `added_at`
  2. Watched items, oldest by most-recent watch event (re-watched stays alive longer)
  3. Unwatched items, oldest by `added_at`, skipping last 48h
  4. Saved items — never recycled
- `file_state` transitions `live` → `recycled`. `file_path`, `nginx_url`, and `file_size_bytes` cleared; `status` unchanged so the card stays in its timeline tier. Row preserved.

**Restore (one tap):** same yt-dlp pipeline re-runs. Original guard verdict preserved — no re-triage. Card stays in its original timeline position.

**Non-restorable (`file_state` = `gone`):** YouTube removed the source, channel taken down, geo-block. "No longer available" treatment, offers to find similar via search.

The nightly recycler pass runs on the M4 (04:00 local, before discovery and profile-enrichment). File unlinks land on the existing delete queue and are executed by the Ubuntu worker.

### Reliability

YouTube is in an active arms race with download tools. Three failure modes, all operational:

1. **yt-dlp breaks** — YouTube ships changes every 1-3 months; fixes land in 24-48h
2. **PO Token plugin breaks** — same dynamic
3. **Rate-limiting** — *"This content isn't available, try again later"*. Recovery is to back off

**Mitigations:**

- Weekly cron on Ubuntu: `pip install -U yt-dlp bgutil-ytdlp-pot-provider`
- Pipeline health check BullMQ job every 15min. If >50% of last 10 downloads failed, send one notification to Steve with actions: `[Update & retry]` and `[Investigate]`. One alert per failure cluster.
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

- Per-user curated list of ~50 high-quality podcasts across their interests (seed + expand over time)
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

Today is structured as three short stretches in a fixed order — **You asked → From people you follow → Picked for you**. Past days are unified lists by date.

- **Provenance lives on the card, not in section headers.** Every card carries a small pill (dot + short label): *You asked* (amber), creator name (teal) for follows, *Picked* (terracotta) for picks. Cards are self-describing wherever they appear — Saved, search, history, Drift — without needing a header above them.
- **Section dividers are structural, not categorical.** Today shows small serif labels with a hairline rule for the *You asked* and *From people you follow* sections. The Picks section has no divider label — its cluster intro line ("I thought you'd like this one…") *is* the section opener (see `docs/design-notes.md`).
- **Single-source days suppress dividers.** A day with only requests just reads as a list — there's nothing to divide.
- **Past days don't use dividers at all.** Past days are unified by date.

**Continuous scroll only** in v1. Day headers separate days. No date picker, no calendar, no time-jump.

### Card states

Three visual tiers reflecting file state (video only; other types skip this):

- **Live** — file on disk, immediately playable. Full colour.
- **Recycled** — record remains, file recycled. Dimmed thumbnail, restore icon. One tap re-downloads.
- **Gone** — YouTube removed. Heavily dimmed, "No longer available", offers find-similar.

Watched state is an additional overlay — tick + "Watched Xh ago" replacing duration.

### iPad layouts

More of the timeline visible at once is the goal.

- **Portrait (≥768px)** — two-column grid within each day
- **Landscape (≥1024px)** — three-column grid, left sidebar with interest filter and search

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

Card shows: thumbnail, interest pill, source (person name where known), headline, one-sentence personal hook, duration/read time/page count. Past-day cards also show "Watched Xh later" if applicable.

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

Full-text across the whole timeline via SQLite FTS5. Matches title, channel, description, and transcript. Flat results list ordered by relevance, card's original date shown beneath. Also powers "find similar" for gone cards.

Text-only in v1. Filters (saved, person, date range, interest) come in a later polish pass.

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
- **Uncertain** → escalate to parent via notification. Kid sees "waiting for a grown-up."

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

**Layer 1 — Explicit.** Interests in user-defined rank order with per-interest expertise level, followed people (Section 4a), hard exclusions (kids' invisible to them). Interests have two provenances — *declared* (the user typed them) and *inferred* (derived from followed people). Inferred interests are proposals, inert until the user keeps one, at which point it becomes an explicit interest. The governing principle (ADR-0008): every discovery input traces to a human act — a declaration or a follow — never to watch behaviour alone. Watch behaviour weights existing interests and surfaces in Drift, but never originates one.

Duration preference is deliberately *not* a Layer 1 input. People watch a wide range of lengths for different reasons; asking them to pick "short / medium / long" produces a knob that's easy to mis-set and hard to update. If a duration pattern shows up in real engagement, it surfaces through Drift as observation, not configuration.

**Layer 2 — Behavioural.** Completion rate per interest/person/duration-band, save rate, dwell-before-dismiss, re-watch count, requested-and-finished rate.

**Layer 3 — Person-level trust.** Per-person trust weights inferred from engagement. Completing most of a person's outputs across media → high trust. Dismissing consistently → low trust. Drives heavy scoring input.

**Layer 4 — Inferred affinities.** Gemma-generated sentences describing shape of preference: *"Likes long-form technical explainers, not short listicles."* Internal only v1 — not exposed in UI. Kids see Layer 4 indirectly via "why this?" on picks.

### "Why this?"

Every item surfaced by discovery (not requests, not direct outputs from people you follow — those are self-explanatory) carries a one-sentence Gemma rationale. It renders inline on the video detail page in a "Why this video" block, and inline on the candidate card before the user adds it (so the rationale is visible at decision time, not buried behind a tap). Earlier drafts of this section specified a tap-to-see sheet; reversed once the full video page existed to host the rationale without crowding the feed.

Where a followed person is involved, the reasoning routes through them wherever possible:

Adult: *"Tyler recommended this book twice in the last six months, and it's on something you've been reading about."*

Kid: *"DanTDM doesn't usually make redstone videos, but this one's exactly the kind of thing you finished last week."*

If Gemma can't explain why, the item doesn't surface.

### Discovery sources

v1 (Phase 5):

- **New outputs from people you follow** — their YouTube uploads, Substack posts, podcast appearances, book releases. Strongest signal.
- **Recommendations from people you follow** — Gemma detects pointers in their text output (book mentions, linked essays), surfaces as candidates with recommender attribution.
- **Interest search** — daily `ytsearch20:'interest keywords'` for top-ranked interests (declared, or inferred-then-kept). Used when person-sourced candidates are thin. Only interests specific enough to yield good queries generate a search; broad interests serve as scoring vocabulary but produce no `ytsearch` (search-seed is decoupled from scoring-vocabulary).
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
       - Run interest searches for top-N interests (fill gaps)
       - Poll curated podcast list
       - Dedupe against seen_items and content_items
  2. Score candidates with Gemma
       - Batches of 10-20
       - Two-axis scoring per candidate (relevance + quality), combined with person-trust and freshness
       - Time-sensitivity classification (livestream / dated / evergreen) drives ranking decay
       - Reject dismissed-pattern matches, blocked people, hard-exclusions
  3. Guard pipeline for kids
       - Clear-yes → surface. Uncertain → parent queue. Clear-no → logged.
  4. Apply daily cap
       - Kids: 3-5 items. Adults: 10-20. Surplus retained for tomorrow.
```

### Scoring axes and time sensitivity

Gemma scores each candidate on two independent axes rather than collapsing them into one number:

- **`relevance_axis`** — does this match what this user is interested in right now? Driven by interest match, person trust, recent engagement patterns.
- **`quality_axis`** — is this a good piece of content on its own terms? Driven by signals about the item: clear subject, production quality, length appropriate to claim, not engagement-bait.

Splitting the axes lets the ranker weight them differently per surface (a kid's "Picked for you" leans heavier on quality; an adult's leans heavier on relevance) and lets us spot-check failures cleanly — a 9 on relevance and a 2 on quality is a different problem from the reverse.

A separate **`time_sensitivity`** column classifies each candidate as `livestream`, `dated`, or `evergreen`. Livestreams should never sit in the candidate pool overnight; dated items decay rapidly; evergreens carry forward without penalty. This stops the surplus-carry mechanism from dragging stale time-sensitive items into a future day's picks.

Both columns live on `candidate_pool` (migrations 018–020).

### Scarcity

Cap is firm. Surplus carries forward but never inflates a single day. Finishing "Picked for you" is a valid state — show *"That's Today."* at the bottom rather than paginating.

### Balance: a choice, not imposed

When imbalance is pronounced (>70% one interest across multiple days, triggering at most once per 1-2 weeks), Eddy surfaces a single in-feed prompt — not a notification, not a nag:

> *"You've watched a lot of Minecraft recently. Want today's picks to stretch you a bit, or stay in the groove?"*
> [Stretch me] [Stay in the groove]

Both options lead to good picks. Stretch biases toward adjacent interests the user has shown some engagement with. Stay honours the current pattern. Not a punishment.

Kids see this too. Noticing your own patterns in real time is part of the literacy principle.

### Kid transparency

Kids see: their own interests, people followed, watch history via timeline, "why this?" on every surfaced item, balance prompts.

Person-level observation for kids is qualitative: *"You've been really into this creator lately."* Never quantitative or ranked.

Kids don't see: hard exclusions (gaming risk), parent-only notes, raw confidence numbers, full Gemma reasoning on clear-no rejections, pipeline/queue internals, cross-person hour tallies.

Adults see everything about their own profile. Parents see full detail of kid profiles except real-time viewing (that would be surveillance).

### Cold start

First 3-4 weeks, behavioural signal is thin. The cold-start surface is the **whole-feed empty state** — there is no separate "Picked for you" cluster to hang it on (ADR-0009 collapsed Today into one unified stream). When the feed has no cards in any tier it shows *"Eddy is still figuring out what you like."* over a second line naming the inputs and the timing: the feed is built overnight from the people you follow and the interests on your profile, and a shared YouTube link gets something now. Aligns with Drift's "Getting to know you" baseline.

The copy is deliberately **not** imperative. The empty state means "no cards", not "no inputs" — a kid who has just followed people and declared interests still sees it until the nightly discovery pass runs and the downloads land, so telling them to follow someone and add an interest would name the two things they have already done and blame them for a server-side wait.

There is no rating prompt, and no rating affordance anywhere in the PWA. Watch is the positive signal; deleting from the player is the strong negative one. Nothing asks the user to score a video.

There is no mandatory gate. An empty "Picked for you" is a valid state — a user with no follows and no declared interests is carried by the request flow until follows accumulate and inferred proposals appear. Following someone is the cheapest path into discovery; declaring an interest is the forward-looking one. Neither is required to proceed.

### Interests

Interests are named subjects with a set of yt-dlp search strings. The `search_terms` JSON array is what does the work — `ytsearch20:'minecraft redstone tutorial'` runs daily as a gap-filler when person-sourced candidates are thin. The label is the only display field (an emoji column was tried and dropped — it added noise without helping recognition).

An interest plays two independent roles: **scoring vocabulary** (the connection axis reads every interest's label and expertise) and **search seed** (only interests with `search_terms` generate `ytsearch` queries). The roles are decoupled — a broad interest ("AI", "Running") stays as vocabulary but generates no query, because `ytsearch20:'AI'` is noise. Search-term generation returns an empty array for interests too broad to search well.

**Declared interests are freeform.** No taxonomy to pick from. User types an interest; one Gemma call generates the `search_terms` array (empty if too broad). Specificity is the input quality knob — *"minecraft redstone"* generates better search terms than *"minecraft"*; *"olympic distance triathlon training"* beats *"fitness"*. The input affordance prompts for it: *"Add an interest. Be specific."* Declaration is the only forward-looking input — the way to point Eddy at something you don't yet follow or watch.

**Inferred interests are derived, not declared.** When a user follows a person, Gemma links that person's channel(s) to existing interests (`channel_id → interest_id`; reads channel description and recent titles). Those links, joined against the user's follows, *derive* a set of inferred interests live — not stored, not auto-applied. They surface in the profile as proposals (see Profile editing). They are **inert until kept**: an inferred interest does not feed search or scoring until the user keeps it, at which point it is promoted to a declared interest. Following a person already gives you that person's outputs; keeping the inferred interest is the separate human act that asks Eddy to hunt the broader topic. Inference only ever proposes interests already in the shared vocabulary — generating *new* vocabulary from channel content (the specificity lever) is deferred (ADR-0008).

**Onboarding:** No mandatory gate (see Cold start). Kid setup is parent-driven — the parent can import the kid's follows and type a declared interest or two; adults seed their own. New declared interests append to the end of the rank order; expertise defaults to `comfortable`. A user who declares nothing and follows no one is carried by the request flow until follows accumulate.

### Profile editing

The explicit profile (Layer 1) is editable on a single page. Two sections, no tabs:

- **Interests** — two zones. On top, the **declared** interests: a draggable ordered list of chips. Each chip shows label and a small expertise indicator (beginner / comfortable / deep). Tap a chip → bottom sheet with remove and expertise selector. Plus-button at the end adds a declared interest via the freeform input flow. Below, only when non-empty, an **"Eddy noticed"** band of inferred-interest proposals, ordered by signal strength, each with explicit **Keep** and **Remove**. Inferred interests have no rank and are never interleaved into the declared list (they have no rank to interleave by). **Keep** promotes the proposal into the declared list at the next rank; **Remove** suppresses it (it stops being proposed; it does not unfollow anyone). The data flow inverts here: Eddy reflects back what your follows imply, and you decide what to keep — declaration is no longer a blank form you must fill before starting.
- **People** — links into the people management surface (Section 4a).

The Profile page is the only surface for editing interests — there is no separate `/interests` PWA route. The API routes under `/interests/*` stay as the contract for the PWA and any future client.

**Rank, not weight.** Ordering is the input. Stored as an integer `rank` per user per interest; reordering is a swap of two values. Discovery scoring derives the weight at runtime as `1 / sqrt(rank)` — the ranker gets honest total-order signal without a slider to fiddle.

**Expertise.** Per user-interest enum: `beginner | comfortable | deep`. Defaults to `comfortable` on add. Passed to Gemma as scoring context so it prefers level-appropriate candidates. Per-user-per-interest, not global — the same interest can be `beginner` for one kid and `deep` for an adult.

**Schema.** The `user_interests` join table carries `rank INTEGER NOT NULL` and `expertise TEXT NOT NULL CHECK (expertise IN ('beginner','comfortable','deep'))`. The legacy `weight` column is dropped (or kept as a generated column from `rank` only if a reader still depends on it during migration).

**Kid vs adult asymmetry.**

- Reordering and expertise changes are free for kids — they reshape ranking within already-approved interests, no new content fetched.
- Removing an interest is free. Removing an inferred proposal (suppressing it) is also free — it fetches nothing.
- **Adding** a new interest for a kid routes through the guard as a request_type distinct from content requests, so the eval set stays clean and per-type metrics stay meaningful. Clear-yes adds it; uncertain escalates to parent; clear-no rejects with reason + appeal.
- **Keeping an inferred interest is an add** — for a kid it routes through the same guard path as a declared add. The proposal being derived from an already-followed person does not bypass the guard; promotion to an explicit, topic-hunting interest is the gated act.
- Hard exclusions remain parent-managed and invisible to kids.

Layers 2–4 are not editable. Drift (Section 10) is where observations from those layers surface; Gemma never writes to the explicit profile directly.

---

## 10. Drift — the literacy surface

Weekly. Not a score to optimise. A mirror to read.

### For kids

Every Sunday evening, Eddy generates a one-page summary:

- **How you spent your time this week** — interest breakdown, visual bars
- **Who you spent it with** — people you followed and engaged with, qualitative
- **What you kept watching** — completion rate, favourites
- **What you asked for and got** — requested vs pipeline-surfaced
- **One observation** — Gemma-written sentence: *"You watched a lot of Minecraft tutorials this week and finished most of them — looks like you're learning something specific."*

No number. No target. No week-on-week comparison. Optional streak counter tracks *interest diversity*, not volume.

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
- Notification to both parents with actions: `[30 min] [1 hour] [Deny]` (top priority, bypasses DND)
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

One system for everyone, every event class. Everything in the codebase calls `notify()`, and that narrow interface is the decision (ADR-0003): no email, no SMS, no Web Push, no Pushover, no per-event-class routing. One channel, whatever technology is behind it.

### Transport

**Today: log-only.** ntfy was removed on 2026-09-19 — unused after the first week, and its certificate had been expired since 2026-07-12, so every send had been failing for ten weeks without anyone noticing (ADR-0003 amendment). `notify()` still fires on every event and writes it to the structured log; nothing reaches a device. Every event below is specified, none is delivered.

**Next: APNs, through the native iOS shell** (Section 21, ADR-0013). Not a second channel alongside anything — the first real transport behind `notify()`. Payloads that transit Apple carry an opaque message id and placeholder copy only; the Notification Service Extension fetches the real content from the M4 over Tailscale (Section 14, ADR-0004).

Phase 6 (guard live) depends on it: an uncertain verdict has to reach a parent to be adjudicated.

### Events and priorities

Priorities are relative, and map onto whatever the transport offers — `max` is the class that must break through Do Not Disturb.

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

Events land with their phases. Five kinds exist in code today — `video_ready`, `parent_review`, and three ops alerts to Steve: `download_alert`, `circuit_open`, `download_failure_streak`. Override events arrive with Phase 9, Drift with Phase 8.

### Signed-token action endpoints

Action buttons call back without a full auth flow.

When Eddy sends a notification with actions:
1. Generate short-lived signed token (HMAC-SHA256, 1h TTL, single-use)
2. Action URL: `https://eddy.tail-xxxx.ts.net/action/{handler}?token={token}`
3. Endpoint validates signature + TTL, looks up token in `used_tokens`, runs handler if unused, marks used, returns confirmation or PWA deep-link

Same pattern for every action across every notification.

### Parent PIN on approvals

Approvals require a parent PIN. Signed tokens prove the device received the notification; the PIN proves the parent is the one acting. Without it, anyone holding the parent's unlocked phone — including the kid — can approve content the guard escalated.

Applies to every action that grants something to a kid or changes their profile:

- Guard approve / deny (uncertain verdicts and appeals — Phase 6)
- Override grants — Pi-hole and TV access (Phase 9)
- Parent edits to kids' interests, followed people, expertise

Not applied to kid-facing actions (tap to play, save, dismiss) or parents' own informational notifications (video ready, weekly Drift).

One PIN per parent, stored as scrypt hash. Same PIN across every approval surface — notification action URLs and direct PWA (e.g. `/admin/guard-review`) — so there is one mental model, not two. Rate-limit wrong attempts. Reset via SSH-only CLI; no over-network recovery flow.

### Module interface

```typescript
notify(user_id: string, event: EventType, payload: EventPayload): Promise<void>
```

Everything else in the codebase calls this. Today it logs; the native shell adds APNs *behind this interface* (Section 21). Narrow interface, not a plugin abstraction — swapping the transport touches one module and nothing else.

> The implemented signature is `notify(event: NotificationEvent, recipient: string)` — event-first, with the payload folded into a discriminated union on `event.kind`. Treat the code as canonical.

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
| Adult profile interests and followed people | ✓ | ✓ |
| Adult Drift summary | ✓ | ✓ |
| System status, queue depth | ✓ | ✓ |

No automated external calls in v1. Claude API usage (Phase 11, optional) requires explicit config and logs every call.

---

## 15. Data model

SQLite, single file on M4, nightly backup to Ubuntu. **The migrations in `src/db/migrations/*.sql` are the source of truth** — reading them top to bottom gives the exact current shape. Inspect live schema with `sqlite3 eddy.db '.schema'`.

Design rules the schema should obey:

- All user-scoped tables carry `user_id`.
- Timestamps are ISO 8601 strings.
- Primary keys are UUID v7, except YouTube IDs as PKs on video-specific tables.
- New tables land as a new numbered migration; never edit a shipped migration.

Per-phase additions are described in the relevant section of this document (e.g. guard tables in §9, discovery tables in §9a, balance prompts in §9a). Cross-reference to a specific table should point at its migration, not at a duplicated DDL block here.

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
│  [interest pill] ·  [person]    │   DM Sans --text-xs, uppercase
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

React 19 + Vite · Framer Motion · Zustand · TanStack Query · Lucide.

A single `/design-reference` route in the PWA shows every component in every state. Serves as the design doc.

---

## 17. Build plan

Eleven phases. Sequential. Each ends with something the household uses — for the family, or for Steve as the person tuning the system.

A session is a focused working block of a few hours ending with the system runnable, committable, typecheck/lint/tests green. Estimates below are rough and will shift as reality lands.

- **Phase 0 ✅** — Foundation
- **Phase 1 ✅** — Request flow
- **Phase 2 ✅** — Feed (core)
- **Phase 3 ✅** — Guard in shadow mode
- **Phase 4 ✅** — Channels, subscriptions, search
- **Phase 5 ✅** — Discovery
- **Phase 6a** — Rubric and parent decisions
- **Phase 6b** — Guard live
- **Phase 7** — Adult sources
- **Phase 8** — Drift
- **Phase 9** — Overrides & blocking (gated on partner buy-in)
- **Phase 10** — MCP
- **Phase 11** — Frontier escalation (optional)

Outside the numbered phases: the **native iOS shell** (Section 21) is a separate track, not a phase. Nothing gates it, and it gates one thing — **Phase 6**, which needs the shell's APNs push to get an uncertain verdict in front of a parent (ADR-0013). Since ntfy's removal there is no other way to reach a device.

Also outside the numbered phases: the **guard classifier track** (Section 22) — a public floor benchmark, then a frontier-labelled public pool and a small local student model (ADR-0014). It starts once Phase 6a's rubric exists and never gates a phase; the guard adopts a new model only if it beats the incumbent on the harness.

### Phase 0 ✅ — Foundation

Monorepo, TypeScript strict, two Node entry points (M4 API, Ubuntu worker), shared modules, SQLite bootstrap, BullMQ + Redis, the notifications module behind `notify()`, HMAC-auth'd internal callback, `.env` validation, Tailscale wiring end-to-end.

### Phase 1 ✅ — Request flow

Kid shares a YouTube link via iOS share sheet → Shortcut POSTs to M4 → job enqueued → Ubuntu worker pulls, yt-dlp downloads to `/mnt/ssd/eddy/videos/` → callback to M4 marks ready → kid gets a "ready" notification → opens PWA, plays.

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
- Interest filter (flat list)
- Bottom nav
- `/design-reference` route

Default-allow pipeline: every request auto-approves and downloads. `requests.status` and `requests.decided_by` fields exist but `decided_by` is always `'auto'`. Phase 6 introduces `'gemma'` for clear verdicts and a parent's `user_id` for adjudicated/appealed ones — schema is correct for Phase 3 onward, no retrofit needed.

No channels, no subscriptions, no search, no discovery, no guard. Those are later phases.

**Ends with:** a timeline PWA showing every card ever added, restore for recycled files. Kids request, it appears, they watch it.

### Phase 3 — Guard in shadow mode

Spec in Section 9. ~2 sessions.

Gemma scores every request. Verdicts are logged, not acted on. Downloads still auto-approve. The purpose of this phase is to build an eval set from real household traffic before putting Gemma in the critical path.

- `guard_eval` table populated on every request (see Section 15)
- Guard runs **before download** — same position it'll occupy in Phase 6, so Phase 6 is a default flip not a refactor
- Prompt designed properly now, not as throwaway scaffolding. Phase 6 tunes against the dataset Phase 3 builds, so the prompt needs to be close to the one that ships.
- CLI labelling tool (`npm run label-guard`): iterates unlabelled verdicts, shows URL + title + channel + Gemma's verdict + reasoning, accepts `a`/`d`/`s`/`q`. If disagree, follow-up for correct verdict. Writes `human_verdict` and `human_labelled_at`.
- No kid-facing change. No parent notification. No review surface. Downloads still auto-approve regardless of verdict.

**Ends with:** every request scored by Gemma. Steve labels verdicts periodically via CLI. After a few months, a real eval set exists. Family sees no change.

### Phase 4 — Channels, subscriptions, search

Specs in Sections 4a and 8. ~3 sessions.

- `people`, `person_outputs`, `followed_people` tables (kids' v1: one YouTube channel = one person)
- Person search + follow flow
- RSS polling per followed channel, 6h interval
- New channel outputs flow through the same request pipeline — including the shadow guard, so channel-originated items contribute to the eval set
- Today's feed gains a "From people you follow" section
- Full-text search via FTS5 over titles, personal hooks, person names, interests
- Search UI in the PWA

**Ends with:** kids follow channels, new videos appear automatically, search works across the whole library.

### Phase 5 ✅ — Discovery

Specs in Sections 4a and 9a. ~2-3 sessions.

**Shipped:**

- `candidate_pool`, `person_recommendations`, `inferred_affinities`, `channel_interest_links`, `balance_prompts` tables
- Discovery engine as a BullMQ repeatable job on M4 — interest search via `ytsearch`, daily cap with surplus carry-forward
- Gemma scoring in batches, `why_text` stored per candidate; two-axis scoring (relevance + quality) and time-sensitivity classification on `candidate_pool` (migrations 018–020)
- Shadow guard runs on discovered items the same way it runs on requested items
- "Picked for you" cluster in Today, with end-of-list state (*"That's Today."*)
- Balance prompt (>70% concentration, max once per 1-2 weeks)
- Schema rename: topics → interests across tables and columns (migration 014)
- `age_gate` flag and `emoji` column dropped from interests (migrations 016, 017)
- Standalone `/interests` PWA route removed — Profile is the only edit surface; `/interests/*` API endpoints retained
- Freeform interest creation is the only path (Gemma generates `search_terms` from typed input)
- Channel → interest inference at subscribe time
- Profile editing surface — `Profile.tsx` with rank-ordered draggable interest list, expertise picker, freeform add. Rank-replaces-weight on `user_interests` (migration 015: `rank INTEGER`, `expertise TEXT CHECK (...)`)
- Person bio + photo captured from YouTube channel info, person view page, tap-through from cards/watch/search (issues #40–43)
- `watch_events` table (migration 021) capturing per-play-attempt signal — feeds Layer 2 behavioural signals and Drift dwell observations
- Layer 2 behavioural snapshot (`behavioural_signals` table, migration 026) — thin v1: `watched_count` and `dismissed_count` per `(user, person)`, recomputed nightly. Richer signals (completion-by-duration, dwell, save rate, requested-and-finished) deferred to Phase 8 where Drift renders them
- Layer 3 per-person trust weights inlined in discovery scoring (#79)
- Layer 4 statement-shaped `inferred_affinities` with weekly Gemma run; `affinity_evidence` rows link each statement to its source content_item / person / interest (migration 027, #81)
- Cleanup job — `pruneStalePool` deletes pending/scored candidates older than 30 days, runs at the end of every daily discovery pass
- Kid interest-add routed through the guard as a distinct `request_type` `kid_interest` (migration 023 adds `request_type`/`subject_text`/`interest_id` to `guard_eval`). `/interests/user-add` enqueues the eval for kids only — after search-term generation for new interests, directly for existing ones — and the verdict is logged shadow-only
- "Why this?" — hard filter at surface time (`why_text IS NOT NULL` in both the surfacing and preview queries, with blank/title-echoing text normalised to `null` at scoring), plus the explanation rendered inline: a voice line above each Today card that carries a `why_text` (share-sheet requests have none) and a "Why this video" block in the detail sheet
- Cold start — whole-feed empty-state copy in `Feed.tsx` names the inputs (follows, declared interests, a shared link) and the overnight timing, under the brief's framing line. No new trigger logic; the existing empty-state condition is the cold-start moment, which means it also fires for a user who *has* inputs but no content yet — hence non-imperative copy. Spec rewritten to match in § Cold start, including the no-rating-affordance decision

**Deferred to Phase 7** (need richer text outputs than YouTube descriptions to be worth the build):

- Recommendation extraction — Gemma reading followed people's text outputs to populate `person_recommendations`. YT-only descriptions yield too little signal; lands naturally alongside Substack/podcast/book ingestion
- Related-people expansion (for follow suggestions, not direct surfacing) — same reason; also gets a natural home when Phase 7 introduces new card types and surfaces

**Ends with:** Today carries discovery picks (in the unified stream, per ADR-0009 — no separate "Picked for you" cluster) with visible reasoning, mostly naming a specific person. Kids follow people via YouTube channels (v1). Scarcity principle honoured. Guard still shadow-mode.

### Phase 6 — Guard live (split into 6a and 6b)

Spec in Section 9. The original plan assumed the Phase 3–5 eval set would be substantial by now; in practice it holds 4 labelled verdicts out of ~5,100 (2026-09-25), because labelling by CLI never became a habit. Prompts can't be tuned against a dataset that doesn't exist, so the phase splits: 6a builds the surface that produces labels as a side effect of parent decisions, 6b flips requests live once those labels show the thresholds are met.

**Prerequisite: push (APNs) is live.** Uncertain verdicts have to reach a parent, and since ntfy's removal notifications are log-only — so stages 4–5 of the native shell (Section 21) ship before this phase does. A guard that escalates into a log file is a guard that blocks kids indefinitely.

#### Phase 6a — Rubric and parent decisions

Discovery candidates are already enforced (kids only surface `clear_yes`), and ~1,300 sit parked as `guard_pending` with no way to resolve them. 6a gives them a path and starts the eval set. Kid requests stay in shadow mode.

- **Rubric** — v1 written: `docs/guard-rubric.md`. Eight scored dimensions, four hard stops, two flags, a per-age-band limits table and the verdict mapping. 6a turns it into the guard module's versioned source, read by the guard prompt, parent reason chips, and (later) the classifier track. Models score dimensions; the limits table decides.
- **Frame picker safety floor** — the thumbnail picker (§6) rejects any frame scoring above 1 on the rubric's Violence, Frightening or Sexual dimensions. Today it scores composition only, and the ffmpeg fallback samples mid-video.
  Built: every image the picker would show (creator thumbnail, YouTube auto-frame, ffmpeg frame) is scored by Gemma (`thumb-safety-v1`) and rejected above 1 on any of the three; a scorer error is a reject; at most four checks per video; winners are served from a local copy of the checked bytes; nothing passing → neutral placeholder, never the creator image. The placeholder is also the interim thumbnail between download and the picker. Plex poster not yet covered.
- **Richer candidate inputs** — store and prompt with the Data API fields already fetched and discarded (description, tags, category, `contentRating.ytRating`) plus `status.madeForKids`. Age-restricted is an automatic clear-no, no model call.
- **Download-time second pass** — transcripts already arrive free with every download (the info JSON carries auto-captions). When a slate pick downloads, re-guard it with the transcript before the card becomes visible; a metadata-only clear-yes the transcript contradicts never shows and becomes an Escalation. No extra yt-dlp traffic, no quota.
  Built: a kid's slate pick lands in hidden `guard_review` on download; a guard-queue job on the M4 re-guards it (`candidate-transcript-v1`, or `-no-transcript` when captions are missing) and moves it to `ready` on clear-yes or parks it as request status `guard_pending`, file kept, on anything else or any failure.
- **No transcript fetch for undownloaded candidates** — parked, to avoid adding yt-dlp traffic (ADR-0011/0012). Every alternative route is owner-only (Captions API), the same IP exposure (timedtext, transcript libraries), or a third party receiving interest-derived video ids. Revisit only if the uncertain pile stays large after the re-run.
- **Re-run the parked backlog** with the richer inputs before building the queue for it.
  `npm run guard:rerun-parked` evaluates into `~/data/eddy/parked-rerun.json` (resumable, `--limit N` to trial) without touching `candidate_pool`; `-- --apply` backs up the DB and applies the verdicts to rows still parked.
- **Parent decision surface** in the PWA (not `/admin/guard-review` — "review" is a glossary avoid-term):
  - **Escalations** — parked uncertain candidates, guard verdict and reason shown. Approve → eligible for the kid's slate; deny → `guard_rejected`.
  - **Spot checks** — 5 a day (4 clear-yes, 1 clear-no), sampled from the last 7 days across both kids, candidates and requests. Guard verdict hidden until the parent answers. A denied clear-yes leaves the kid's feed; an approved clear-no becomes eligible; a spot check on an already-downloaded shadow-mode request records a label only.
  - Daily queue capped ~15 items, escalations first; escalations older than 14 days appear only in **catch-up mode**, which lifts the cap and draws further spot checks from older verdict history.
  - Optional reason chips per decision, one per rubric dimension, plus free text.
  - Decisions are per kid (age bands differ); "same for both" when a video is pending for both.
  - Every decision writes `guard_eval.human_verdict` with its source (escalation / spot check), rubric version, and age band at decision time.
- **Daily nudge** via `notify()` — "N decisions waiting", only when the queue is non-empty. No per-item push in 6a.

**Ends with:** parked candidates resolvable in a few minutes a day, and a labelled set growing at ~5 spot checks + escalations per day. ~150 clear-yes spot checks (≈ ±3.5% on precision) in about five weeks, sooner with catch-up sessions.

#### Phase 6b — Guard live for requests

Gated on 6a's labels meeting the thresholds.

- Tune against the labelled set until thresholds hit (95% clear-yes precision, 90% clear-no precision, 10–30% uncertain rate)
- Flip `decided_by` default: clear_yes auto-approves, clear_no auto-rejects with reason, uncertain escalates
- Parent push for uncertain verdicts with approve/deny actions (signed-token pattern)
- Appeal flow — kid taps "ask again" on a rejection, Gemma re-evaluates with the appeal context, still-uncertain escalates to parent
- Kid-facing rejection reasons (age-appropriate phrasing, not raw Gemma output)
- First month: spot checks continue at the 6a rate

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
- **Deferred from Phase 5:** general recommendation extraction across all followed people's text outputs (populates `person_recommendations`), and related-people expansion (guests, collaborators, frequently-mentioned) feeding a follow-suggestions surface — both wait on richer-than-YT text inputs to be worth the build

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
- Notification actions for parent approval
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

---

## 19. Open questions

Resolve before or during the relevant phase.

1. **Gemma inference throughput on M4 with 16GB RAM.** Can it handle scoring + hook generation + triage + recommendation detection on a busy day without swap? Instrument in Phase 3, adjust batch sizes if needed.
2. **Whole-house DNS coverage (Phase 9 decision).** HH2 can't push DNS to DHCP clients. Tailscale-only may be sufficient once kids are using share-sheet for most requests. If not: Pi-hole-as-DHCP (fragile but free) or router replacement (~£140 for UniFi Cloud Gateway Ultra). Decide at start of Phase 9.
3. ~~**Eddy domain name.**~~ **Resolved** — `eddyhq.app` is live over HTTPS behind Caddy, tailnet-only. Custom scheme rather than universal links follows from that; see Section 4.
4. **Recommendation detection quality.** Gemma extracting book/article/podcast recommendations from a person's text output is the novel piece in Phase 5/7. Signal quality unknown until tested on real data. If poor, fall back to "new outputs only" for followed-person discovery and revisit.
5. **Kid person-level UI tone.** "You've been really into this creator lately" is the intended register. Exact phrasing matters — reviewing with kids during Phase 5 is part of the work, not an afterthought.

### Known dependencies

- **APNs** — once the native shell ships (Section 21), Apple's push infrastructure is the only path from Eddy to a device. Single point of failure outside our control, and deliberately the only one: no fallback channel (ADR-0003). Until then there is no push dependency, because there is no push.
- **yt-dlp + bgutil-ytdlp-pot-provider** — active arms race with YouTube. Both well-maintained, typical fix times 24-48h. Mitigation is operational (Section 6 Reliability). No credible architectural alternative.

---

## 20. Project identity

- **Name:** Eddy — a current that moves differently to the main flow
- **Weekly summary name:** Drift
- **Repo:** `eddy-hq/eddy`
- **Licence:** MIT
- **Open source:** when stable (post-Phase 8). Per-household native builds require per-household Apple Developer accounts — consistent with self-hosted ethos.

---

## 21. Native iOS shell

A thin native app that wraps the existing PWA. Not a second client. Decision and rejected alternatives: ADR-0013.

### What native owns / what the PWA owns

**Native (Swift + SwiftUI):**
- **Share extension** — appears directly in the iOS share sheet, replacing the Shortcut. POSTs to `/requests`, shows the outcome inline.
- **App Intent** — so Shortcuts and Siri can still reach Eddy for anyone who prefers the old route.
- **APNs push**, including lock-screen `[Approve] [Deny]` action buttons.
- **`eddy://` deep links** — same paths as the web routes.
- **Fallback screen** when Tailscale isn't connected. The one thing a web page can't explain well.
- **User identity in the Keychain**, injected into the web view. Today identity is a `?userId=` query param that every page re-appends by hand; the shell makes it survive.

**PWA (unchanged):** every screen. Feed, player, request landing, saved, search, profile, person view, admin. The web view loads `https://eddyhq.app` over the tailnet — it never serves bundled local HTML, because every PWA fetch is origin-relative.

No native feed. No native player. No second design system.

### Server contract changes

Three additions, all on the M4. Shapes only; implementing agents fill in the detail.

- **`POST /devices`** — device registration carrying the APNs token. Upserts into the existing (currently unused) `devices` table, which gains a token column and a `last_seen_at`. `DELETE /devices/:id` on sign-out or token invalidation.
- **APNs sender behind `notify()`** — the first real transport behind the interface; notifications are log-only until it lands (§12, ADR-0003). Event types, priorities and action URLs are unchanged.
- **`GET /notifications/:messageId`** — what the Notification Service Extension calls to turn an opaque push into real content. Tailnet-only, and authenticated as the device's own user: a message is readable only by its recipient.

Payloads that transit Apple carry the opaque message id and generic placeholder copy, nothing else — no titles, no channel names, no kid names (§14, ADR-0004). The id is random, never a request id or a YouTube id. If the extension's fetch fails, the notification reads "Something new in Eddy" and the content is only visible in the app.

APNs buttons hit the `/action/{handler}?token=` signed-token URLs, unchanged by the channel (ADR-0005) — but note that neither the route nor a target id in the token payload exists yet. Both are owed by Phase 6 whether or not the shell ships.

### Build order

Roughly 7–9 sessions. Sharing is the feature the household actually wants, so it ships first: stages 1–3 put the share extension on every device before any push work starts.

1. **Xcode project** ✅ (simulator-verified) — WKWebView shell, `eddy://` deep links, Keychain identity, Tailscale fallback screen. Lives in `ios/`; see `ios/README.md`.
2. **Share extension + App Intent** ✅ (simulator-verified; extension proven against the live server, the Shortcuts action not yet seen running) — the Shortcut's replacement. Same `POST /requests`, shows `message` inline (§5).
3. **Signing + OTA distribution** — onto Steve's device, then the boys'. *Released and installed over the air on Steve's device (2026-09-19); the boys' devices still to register and install.* The Shortcut is retired per device once the extension is proven.
4. **Server push** — device registration + APNs sender behind `notify()`.
5. **APNs client + Notification Service Extension**, device-tested against a backgrounded VPN, then rolled out — Steve first, then the boys.

Stages 4–5 follow stage 3 directly. They used to wait for Phase 6, on the reasoning that ntfy was doing the job until parent approvals existed; ntfy's removal (ADR-0003) inverted that. Three of the five notification kinds are ops alerts to Steve — `circuit_open`, `download_failure_streak`, `download_alert` — and they are log-only now, so a blocked pipeline announces itself to a file nobody is watching. And Phase 6 cannot ship without stage 5.

### Distribution

Ad hoc provisioning, not TestFlight (ADR-0013 for why).

- Register each device's UDID; 12-month provisioning profile.
- OTA install manifest served from `eddyhq.app` behind Caddy, tailnet-only like everything else.
- Yearly re-sign, with a watchdog warning a month before profile expiry.
- Each self-hosting household signs with its own Apple Developer account.

### Open questions

1. **Will the kids' devices install it?** Screen Time's "Installing Apps" restriction, and whether iOS 16+ demands Developer Mode for an ad hoc build. Both untested.
2. ~~Video inside `WKWebView`~~ — plays fine on a device (2026-09-19).
3. ~~Where the Swift lives~~ — decided: `ios/` in this repo, so the API contract and its client change in one diff.
4. ~~Service extension over a backgrounded VPN~~ — answered by a spike on 2026-09-21 (branch `apns-nse-spike`, not merged). On one iPhone, a Notification Service Extension that fetched `/health` on each mutable push reached Eddy in 66 ms with the phone in use, and succeeded again with the phone locked and idle for 16 minutes on mobile data, Tailscale backgrounded. With Tailscale switched off the fetch failed, so the successes went over the tailnet. Not yet covered: an iPad, a kid's Screen Time-managed device, Low Power Mode, and an overnight idle. Two things the spike surfaced for stage 5: a push that arrives while the app is on screen is dropped unless the app implements the foreground presentation delegate, and with the tailnet down the extension waits out its whole fetch timeout before the fallback copy shows, so that timeout should be a few seconds, not twenty.

---

## 22. Guard classifier track

A separate track, like the native iOS shell: nothing gates it and it gates no phase. It starts once Phase 6a's rubric exists. Decision record: ADR-0014.

The aim is a guard shaped like Luna-2 / Jev — text in, one calibrated probability per rubric dimension out — running locally. At Eddy's volume (~30 verdicts a day) the case is quality and calibration, not cost: a score read from the model's token probabilities can be thresholded, where Gemma's self-reported `confidence` can't.

1. **Harness** — replays labelled items through any guard configuration and reports clear-yes / clear-no precision and uncertain rate, split by label source and rubric version.
2. **Public floor benchmark** — the universal floor (sexual, graphic, disturbing) measured on public data: the Samba test split first (public, has subtitles), Disturbed YouTube for Kids (access by request). Contenders: today's Gemma prompt (baseline), ShieldGemma text, ShieldGemma 2 on thumbnails, and any open Jev-like model worth trying. Visual signal is cheap: Gemma 4 E4B already scores frames in the thumbnail picker, and a candidate's YouTube auto-frames are plain image URLs before any download (confirm they sit outside the ADR-0012 yt-dlp budget). First check: whether Ollama exposes token probabilities — without them there's no real score. Unlike household results, this number is publishable.
3. **Public pool** — 10–20K public videos from the Data API across genres 10–13-year-olds watch, plus public-dataset hard positives. Never seeded from or joined to Eddy's data. Metadata only — no transcript fetching; transcripts come only from datasets that ship them (Samba includes subtitles).
4. **Frontier teacher** labels the pool against the rubric, offline. Steve audits ~300 as gold; iterate the rubric until teacher–gold agreement holds.
5. **Student** — a small head over an embedding model first, LoRA on a small open model if that falls short. Evaluated on gold, the public benchmark, and household decisions. Adopted only if it beats the incumbent.
6. **Loop** — student-uncertain items route into Phase 6a's escalations; those decisions become new gold.

Household decisions stay evaluation-only and, later, retrieved precedents (a new item's nearest past parent decisions in the guard prompt). They are never teacher input or training data.
