# Eddy

Self-hosted family media system organised around trusted humans, not algorithms. This glossary fixes the project's domain language so the brief, the code, the issues, and the agent sessions all use the same words for the same things.

## Language

### Household and people

**Kid**:
A child user with a parent-managed profile and a private consumption record that never leaves the M4.
_Avoid_: child, user, son, daughter

**Parent**:
An adult user with admin rights — full profile, MCP access, guard adjudication, override granting.
_Avoid_: admin, grown-up (in code), guardian

**Boy1 / Boy2**:
Placeholder identifiers for the two kids, used in commits, code comments, logs, and memory in place of real names.
_Avoid_: real names anywhere outside `.env`

**Person**:
The subscription unit in Eddy — an individual creator, duo, or studio treated as a single identity across all the things they produce. See [[0007-people-as-subscription-unit]].
_Avoid_: creator, channel (when referring to who is followed), author, host

**Output**:
A specific feed produced by a **Person** — a YouTube channel, a Substack, a podcast, a book release stream. A person has one or more outputs; following a person subscribes to all of them.
_Avoid_: channel, feed, source

**Recommendation**:
A pointer from a **Person** to something they didn't make — a book they praised, an essay they linked. Becomes a **Candidate** with the recommender's name attached.
_Avoid_: mention, reference, citation

**Follow**:
The verb and the relationship — a user follows a **Person**, subscribing to all their **Outputs** in one action.
_Avoid_: subscribe (in product copy; `subscriptions` is fine as a code identifier where unavoidable)

### Content and the feed

**Item** / **content_item**:
A single piece of content (video, article, podcast episode, paper, book, recipe) tracked in the database. The thing a card renders.
_Avoid_: video (when referring to the generic case), entry, post

**Card**:
The UI rendering of an **Item** on the **Feed**. Self-describing — every card carries its own **Provenance** pill so it works in Today, Saved, search, and history without a section header above it.
_Avoid_: tile, row, post

**Feed**:
The reverse-chronological timeline of every **Card** offered to this user. Anchored by *added date* — a card sits in the day it was added, never moves. The feed is *what was offered to me*; **Drift** is *what did I do with it*.
_Avoid_: timeline (in product copy — it's the same thing but "feed" is canonical), stream, history

**Today**:
The top of the **Feed** — today's two stretches: *You asked* (share-sheet requests), then a unified *Today* stream that mixes **Follow** (subscription + back-catalogue) and **Pick** cards in one composed set, each carrying its own **Provenance** pill. See [[0009-subscriptions-and-discovery-compose-one-slotted-slate]].
_Avoid_: home, today's feed, daily

**Provenance**:
Where a card came from — *request*, *follow*, or *pick*. Rendered as a small pill on every card (amber/teal/terracotta dot + short label).
_Avoid_: source (overloaded), origin, category

**Hook**:
A one-line personal hook beneath the card headline, Gemma-generated in batches. Max 15 words, specific not generic. The "no recommendation without a visible reason" rule lives here.
_Avoid_: blurb, description, tagline

**Saved**:
A bookmarked **Item** — appears in its original feed position *and* in the dedicated Saved tab, and is immune to recycling.
_Avoid_: bookmarked (in product copy), favourited, starred

**Dismissed**:
A card the user has explicitly opted out of via the ✕ — dims in place but stays in the **Feed**, first in line for recycling.
_Avoid_: hidden, rejected (that means something specific in the guard), removed

**Person view**:
The page shown when a user taps a followed **Person** — photo, bio, follow date, six most-recent items, support links, unfollow. Reflective, not a discovery surface.
_Avoid_: creator page, channel page, profile page (that's something else — see **Profile**)

### Request flow and the guard

**Request**:
A kid's explicit ask for a specific URL, almost always via the iOS Share Sheet Shortcut. The load-bearing feature — everything else serves it.
_Avoid_: submission, ask, link

**The guard**:
The triage system that decides each kid **Request**'s outcome — Gemma 4 E4B as classifier, parent as adjudicator.
_Avoid_: filter, gatekeeper, moderator

**Clear-yes** / **Clear-no** / **Uncertain**:
The three guard outcomes. Clear-yes approves; clear-no rejects with a one-sentence reason and an **Appeal**; uncertain triggers an **Escalation**.
_Avoid_: approved/denied/pending (those are downstream states)

**Escalation**:
The parent-decision path for an **Uncertain** request — ntfy notification with `[Approve] [Deny]` actions. Kid sees "waiting for a grown-up" until resolved.
_Avoid_: review, hold

**Appeal**:
The kid's one-tap "Ask a grown-up" affordance on a **Clear-no** rejection. Routes the request to the parent with Gemma's reasoning attached.
_Avoid_: dispute, retry

**Override**:
A parent-granted temporary unblock of YouTube on a specific device for N minutes — for livestreams, football, time-sensitive moments. Lives at the **Pi-hole**, not in the pipeline.
_Avoid_: bypass, exception, allowlist

### Discovery and profile

**Candidate**:
A scored content item in the **Candidate pool** that has not yet been surfaced. Originates from a followed person's new output, a recommendation, an interest search, or podcast discovery.
_Avoid_: suggestion, recommendation (overloaded — that has a specific meaning above)

**Candidate pool**:
The per-user table (`candidate_pool`) of scored candidates the daily discovery engine draws from when populating **Picks**.
_Avoid_: queue (overloaded with BullMQ), inbox

**Pick**:
A **Card** Eddy surfaced via discovery beyond the user's **Follows** (not requested, not new or back-catalogue output from a followed **Person**) — the **Delighter**. It occupies a reserved, floored slot in the composed daily slate and carries *pick* **Provenance**. Renders in the unified *Today* stream introduced by its **Eddy voice line** (its "why this?"), not as a separate always-hero block. See [[0009-subscriptions-and-discovery-compose-one-slotted-slate]].
_Avoid_: recommendation (overloaded), suggestion

**Delighter**:
A **Pick** sourced from discovery *beyond* the user's **Follows** — content Eddy went looking for, not new or back-catalog output from a followed **Person**. Occupies a reserved, floored slot in the daily slate so exploration is never crowded out by follow content. In the base model it is filled by declared-**Interest** search (`source_type = 'interest_search'`); "delighter" names the slot's *purpose* — a genuine serendipity signal (a separate, later issue) is what will make the content live up to the name. Carries *pick* **Provenance** (vs *follow* for subscription and back-catalog cards). See [[0009-subscriptions-and-discovery-compose-one-slotted-slate]].
_Avoid_: left-field, random, suggestion

**Scarcity**:
The design constraint that finishing **Today** is a valid state — daily caps are firm, surplus carries forward but never inflates a single day. The opposite of infinite scroll.
_Avoid_: limit, cap (those are mechanisms, not the principle)

**Balance prompt**:
An in-feed offer — *not* a notification — surfaced when interest engagement skews >70% one way across multiple days: *"Stretch me / Stay in the groove."* Both options lead to good picks.
_Avoid_: nudge, intervention, suggestion

**Interest**:
A topic on the **Profile** that drives interest search and scoring. One primitive, two provenances — see **Declared interest** and **Inferred interest**. Every interest that *originates* a discovery input traces to a human act (a declaration or a **Follow**); watch behaviour weights an interest and surfaces in **Drift**, but never originates one. See [[0008-discovery-inputs-trace-to-a-human-act]].
_Avoid_: topic (was renamed *to* interest), tag, category

**Declared interest**:
An **Interest** the user typed (`source = declared`), carrying rank order and expertise level. Forward-looking — the only way to point Eddy at something you don't yet follow or watch. The ranked, draggable list at the top of the Interests editor.
_Avoid_: explicit interest (use "declared"), manual interest

**Inferred interest**:
An **Interest** Eddy derived live from the user's **Follows** (`follows → channel_interest_links → interests`), surfaced in the profile's "Eddy noticed" band as a proposal with **Keep** / **Remove**. *Inert until kept* — it does not feed search or scoring vocabulary until **Keep** promotes it to a **Declared interest**. Derived, never auto-written; backward-looking by nature.
_Avoid_: auto-interest, suggested interest, observed interest (in code — "inferred" is canonical)

**Follow suggestion**:
A **Person** the user has watched or saved but does not **Follow**, surfaced on the People tab as a candidate **Follow** because they map to ≥1 **Declared interest**. Ranked by engagement strength (watched + saved count); each carries a literal reason-line (*"Watched 4 · saved 2 — football"*). Distinct from a **Pick** (content Eddy surfaced, not a person) and a **Recommendation** (a pointer *from* a followed person). Following one is ungated for kids — the surfacing guard, not the follow, is the safety boundary. See [[0010-kid-follows-are-ungated-the-surfacing-guard-is-the-boundary]].
_Avoid_: suggested creator, recommended follow, people you may know

**Profile**:
A user's four-layer model — explicit interests + followed people + hard exclusions (Layer 1), behavioural signals (Layer 2), per-person trust (Layer 3), Gemma-inferred affinities (Layer 4).
_Avoid_: preferences, settings, account

**Hard exclusion**:
A keyword on a kid's **Profile** that auto-rejects any matching candidate or request — invisible to the kid, set only by a parent.
_Avoid_: blocklist, ban, filter

**Relevance axis / Quality axis**:
The two independent scores Gemma assigns each **Candidate** — *does this match what this user wants now?* and *is this good on its own terms?* Kept separate so failures are diagnosable.
_Avoid_: score (the single-number form was deliberately rejected)

**Time sensitivity**:
A **Candidate**'s classification as `livestream`, `dated`, or `evergreen` — controls ranking decay and surplus carry-forward.
_Avoid_: freshness, age, expiry

### Drift

**Drift**:
The weekly literacy surface — a one-page Sunday-evening reflection of *what the user did with* the **Feed**. A mirror, not a score. Adults see their own Drift; parents see kids' Drift in a richer view.
_Avoid_: report, summary, dashboard, recap

**Observation**:
A single Gemma-written sentence in **Drift** describing a pattern in the week's engagement. Observational, never evaluative.
_Avoid_: insight, finding, advice

### Card states

**Live**:
File on disk, immediately playable. Full-colour **Card**.
_Avoid_: available, ready (overloaded — see request states)

**Recycled**:
Record retained, video file deleted to reclaim space — restorable in one tap. Dimmed thumbnail + restore icon. **Saved** items are never recycled.
_Avoid_: archived, expired, deleted (the record isn't deleted)

**Gone**:
The source removed the video upstream. Heavily dimmed, "No longer available", offers find-similar.
_Avoid_: dead, broken, missing

**Watched**:
Overlay state on any card — a tick + "Watched Xh ago" replacing duration. Orthogonal to live/recycled/gone.
_Avoid_: viewed, seen, consumed

### Infrastructure (Eddy-specific)

**The M4**:
The Mac mini running the API, PWA, SQLite, and Gemma. Thinks but doesn't move bytes. Kids' consumption never leaves it.
_Avoid_: server, host

**The worker**:
The Node process on the Ubuntu box that runs yt-dlp, ffmpeg, and reports back to the M4 via the internal callback endpoint. Moves bytes but doesn't think.
_Avoid_: downloader, agent

**Slate-bound download**:
The only time bytes move: a video is downloaded when the daily slate selects it (or a kid explicitly requests it), never eagerly on discovery or RSS poll. Follow uploads enter the candidate pool without downloading. ADR-0012.
_Avoid_: pre-fetch, eager download (the rejected behaviours)

**Recycler**:
The module that reclaims SSD space by deleting **Live** video files and flipping their cards to **Recycled**. Per-user budgets; **Saved** items immune.
_Avoid_: garbage collector, cleaner

**Fetcher**:
A content-type-specific adapter (YouTube, Substack, podcast RSS, etc.) that turns a **Person**'s **Output** into items. Section 7 of the brief.
_Avoid_: scraper, ingester

**Signed-token**:
The single-use HMAC-SHA256 token (1h TTL) embedded in every notification action URL — validated, looked up in `used_tokens`, marked used. The pattern is universal across every action endpoint.
_Avoid_: action token, magic link, callback token

**ntfy**:
The self-hosted push notification service on the Ubuntu box. The *only* notification channel — no Web Push, no Pushover, no email.
_Avoid_: pusher, notifier (in code, `notify()` is the narrow module interface)

**Topic**:
A per-user ntfy channel, UUID-suffixed (e.g. `eddy-boy1-{uuid}`). Each iOS app holds credentials for its own topic only.
_Avoid_: channel (overloaded), stream

**MCP**:
The Model Context Protocol surface that lets adults manage Eddy from Claude.ai — adults only, kids' consumption detail never returned. Privacy filter enforced at the response boundary.
_Avoid_: API (overloaded), control plane (descriptive but not the term)

## Relationships

- A **Person** has one or more **Outputs**; following a person subscribes to all of them.
- A **Person** also has zero or more **Recommendations** — pointers to things they didn't make, surfaced as **Candidates** with attribution.
- A **Person** the user has engaged with but not followed, and who maps to a **Declared interest**, becomes a **Follow suggestion** — a candidate **Follow**, ranked by engagement; following one is ungated even for kids.
- An **Output** produces **Items**; an **Item** renders as a **Card** on the **Feed**.
- A **Card** carries a **Provenance** (*request*, *follow*, or *pick*) — the same item shared by two people produces two distinct cards with different provenance per user.
- The **Feed** is anchored by *added date*; **Today** is the top stretch of the feed.
- A kid **Request** flows through the **Guard** to one of three outcomes: **Clear-yes** → download; **Clear-no** → rejection + **Appeal**; **Uncertain** → **Escalation** to a **Parent**.
- The **Candidate pool** feeds the daily discovery run; surviving candidates become **Picks** on the feed.
- **Drift** reads engagement against the **Feed** weekly; **Profile** Layers 2–4 update continuously from the same signals.
- A **Card** is **Live**, **Recycled**, or **Gone** (file state) — orthogonally, it may be **Watched**, **Saved**, or **Dismissed** (user state).
- Every notification action endpoint requires a **Signed-token**; every kid-facing **MCP** response passes through the privacy filter or throws.

## Example dialogue

> **Steve:** "If Boy1 saves a video and then I run the recycler, what happens?"
> **Claude:** "Nothing — **Saved** items are immune to recycling. The card stays **Live** until he unsaves it. The recycler only touches **Live** cards that aren't saved, oldest first, within his per-user budget."

> **Steve:** "Boy2 followed DanTDM. So he's subscribed to a YouTube channel?"
> **Claude:** "Under the hood, yes — DanTDM has one **Output** in v1, his YouTube channel. But the unit of subscription is the **Person**, not the channel. When he eventually has a Substack or a podcast, following him already covers it."

> **Steve:** "Why did this **Pick** show up on Boy1's **Today** if its **Relevance axis** was a 4?"
> **Claude:** "Its **Quality axis** was 9 and the recommender is a high-trust **Person** for him — the ranker weights quality heavier on a kid's picks surface. Picks are a curated set, not a ranked list — see `docs/design-notes.md`."

## Flagged ambiguities

- **"Channel" / "creator" / "person" / "output"** — all four words have been used for the subscription unit. **Resolved**: the unit is **Person**; an **Output** is a specific feed they produce (their YouTube channel, their Substack). "Channel" in conversation usually means a YouTube channel — i.e. an output — but in product copy prefer "person" or the person's name. See [[0007-people-as-subscription-unit]].
- **"Recommendation"** — used to mean *(a)* a thing a followed person pointed at, and *(b)* a **Pick** Eddy surfaced. **Resolved**: a **Recommendation** is sense (a) only; senses (b) is a **Pick**. The "no automated recommendation without a visible reason" rule applies to **Picks** — every pick must have a "why this?".
- **"Source"** — used for *(a)* a content **Output**, *(b)* the YouTube site itself, and *(c)* the **Provenance** of a card. **Resolved**: avoid "source" as a domain term; use **Output**, **YouTube**, or **Provenance** as appropriate. The `sources` module name is grandfathered.
- **"Feed"** — used for *(a)* Eddy's timeline, and *(b)* an RSS feed (an **Output**). **Resolved**: the **Feed** is Eddy's timeline; an upstream RSS feed is an **Output**.
- **"Subscribe" / "follow"** — interchangeable historically. **Resolved**: **Follow** in product copy and prose; `subscriptions`-derived names are fine in code where they already exist.
- **"Topic" / "interest"** — the schema rename happened in Phase 5. **Resolved**: **Interest** is the domain term; no more "topic" in new code or docs.
- **"Reject"** — used for *(a)* the guard's **Clear-no**, and *(b)* a card the user **Dismissed**. **Resolved**: guard rejections are **Clear-no**; user opt-outs are **Dismissed**. Don't conflate.
- **"Today"** — used for *(a)* the top stretch of the **Feed**, and *(b)* the calendar day. **Resolved**: capitalised **Today** is the feed stretch; lowercase "today" is the calendar day.
