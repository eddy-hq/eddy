# Decision entries — Eddy feed & timeline design

These four entries capture the feed/timeline design decisions from the Phase 2 UX exploration. They belong in `decisions.md` in the feed-related cluster — insert **after the "Why scarcity as a feature" block ends** (i.e. after the existing horizontal rule following *"This is the explicit counterweight to the engagement-engine pattern the whole system is designed against."*) and **before "Why balance as a choice, not an imposition"**.

The project files in `/mnt/project/` are read-only from my side — you'll need to paste this into the actual file yourself.

---

## Why card-level provenance, not section labels

Original design had three labelled sub-sections in Today: **My requests**, **From people you follow**, **Picked for you**. Each section header did two jobs at once — grouping cards visually, and telling the kid where a card came from.

Changed to per-card provenance for two reasons:

- **Cards travel.** A card seen in Saved, in search results, in Drift, in historical scroll needs to explain itself without a section header above it. Moving provenance onto the card means the card is self-describing everywhere. Whatever provenance treatment works in history works in Today, for free.
- **Empty and single-section days.** Labelled sections create rendering edge cases when a bucket is empty or when only one bucket has content. Per-card provenance sidesteps the problem entirely — there's nothing to suppress because the labels don't exist.

Provenance renders as a small pill on the card (dot + short label): *You asked* (amber dot), creator name (teal dot) for follows, *Picked* (terracotta dot) for picks. The dot colours differentiate at a glance; the label explains on inspection.

Section dividers (see next entry) still exist — but they're *structural* chapter markers for the day, not the primary way a kid knows where a card came from.

---

## Why section dividers for Today, not tabs

Considered pill tabs at the top of Today ("All / You asked / Followed / Picks") as a way to let the kid filter by source. Rejected because:

- **Tabs solve a problem Eddy doesn't have.** The classic tab use case is narrowing down when there's too much. Today has 3–15 items on a normal day — scrollable in seconds. Tabs add a gesture to learn and an ongoing "am I missing something in another tab?" question, without solving anything real.
- **Tabs import the YouTube shape.** Home / Subscriptions / Library is a tab bar. The whole point of Eddy is to not be a "which feed am I in today" surface. One thing: your day.
- **Tabs duck the ordering question.** A tab bar presents sections as peers. Dividers commit to an order, which is a claim the user can evaluate.

Dividers for Today are small serif labels with a hairline rule extending to the right edge. Fixed order: **You asked → From people you follow → Picked for you**. Within each section, reverse-chronological. The picks section has no label — see the "Why Picked has no header" entry below.

Past days don't use dividers. Past days are unified by date, not structured by source. The divider pattern is a Today affordance only.

Single-section days (e.g. a quiet Tuesday with only requests) suppress the divider entirely. With only one source, the label is redundant — the day just reads as a list.

---

## Why the card title is the lead, not a generated hook

Early exploration had a Gemma-generated "hook line" — editorial paraphrase of the video's content — rendered as the card's primary text, with the original YouTube title sitting as a quiet secondary line. Rejected because:

- **The hook is guessing.** Gemma can generate a confident-sounding hook from a title alone, but the specifics are often fabricated. "One module at a time" when Gemma doesn't know the video's structure. "In order" when Gemma doesn't know the ordering. That's the same mechanism as clickbait, in Gemma's voice.
- **Transcript-grounded generation is expensive.** An honest hook needs video transcript as input, not just title + description. That means hook generation runs after download, not before — which complicates feed appearance timing. And it's still a whole extra inference pass per card.
- **The YouTube title is the honest anchor.** It's what the creator called the thing. It's what search queries will match against. It's how a kid re-finds a video. Moving it to secondary and putting a confident paraphrase above it would quietly corrupt the identity signal.

Current model: the card's primary text is the YouTube title, unchanged. Provenance and creator sit in the meta row below. No hook line on requests or follows.

Picks are the exception — a reason-line (not a content description) explains why the item was chosen. That's a different content problem and has its own entry.

---

## Why the Picked voice lives outside the card

On picks specifically, a short sentence explains why Eddy surfaced the item. *"I thought you'd like this one — you mentioned Steve Mould does a good job of explaining physical things."*

Originally rendered inside the card, as a second line of italic serif under the title. Moved to sit **above** the card, flush left at the feed margin, first-person.

Why:

- **It's not a description of the item, it's an introduction to it.** Inside the card, the line reads as metadata — a property of the thing. Outside the card, it reads as Eddy speaking — a voice making a recommendation. Those are different relationships to the content.
- **The card stays visually identical across sources.** No special pick-card layout. Title, provenance, thumb, duration — same as every other card. Card complexity doesn't grow.
- **Eddy gets to be a voice, not a component.** Moving the prose out of the card turns the Picked section into a short conversation rather than a row of recommender outputs. That's the "replace don't restrict" principle at the UI level — a librarian's shelf pick, not an algorithmic ranking.

The cluster follows a consistent shape: first pick introduced with *"I thought you'd like this"*, middle picks with *"And this one…"*, last pick with *"One more"*. The *"One more"* is the structural ending — the cluster has a beginning, middle, and end. It's how the scarcity principle expresses itself in prose: Eddy picked a small number of things and is now done.

A corollary: the Picked section has no divider label. The voice is the section intro. See the next entry.

### Safeguards on the voice

- **First-person, but restrained.** The register is a librarian or older sibling, not a chatbot or a service. Low-key, specific, never emoting. "I thought you'd like this" is fine; "I'm so excited to share this!" is not.
- **Silence over filler.** A pick with no strong reason gets no voice line — it sits under the cluster intro and explains itself by its tag. Eddy only speaks when he has something specific to say.
- **Hedging is out.** *"I think you might like this"* is a recommender qualifying its output. *"I thought you'd like this"* is a person making a choice. Confidence is the point.
- **Cap.** Soft ceiling of ~3 picks per day. Beyond that the voice becomes the feed rather than something in the feed. This aligns with the daily cap the discovery engine already enforces.

---

## Why per-section density, not per-day

Three card modes exist — **hero** (16:9 poster, typography overlaid on a blurred backdrop), **compact** (horizontal, 112px thumb + title + meta), and *implicitly* a future deeper-compressed mode used in history (see the timeline-gradient entry).

Early model was per-day: a day with ≤5 items rendered all cards as hero; 6–14 as standard; 15+ as compact. Rejected because:

- A heavy day is usually heavy because of a burst of channel activity. Forcing requests and picks into compact-because-of-day-count punishes the highlights for the follows' density.
- The mode should match the job. Requests and picks are short (2–4 each) and benefit from poster treatment. Follows can range from 1 to 20+ and need to scale.

Current rule:

- **Requests** — always hero. Capacity is naturally small.
- **Picks** — always hero. Capped at ~3 by the discovery engine.
- **Follows** — hero if ≤6, compact if >6.

A mixed-density day looks intentional, not inconsistent, because each section owns its treatment. The divider pattern reinforces this — each section is visually its own chapter.

---

## Why the timeline uses a memory gradient, not uniform scrollback

> **Status (April 2026):** Tiers 1 and 2 shipped in Phase 2 (`Feed.tsx` `Tier 1 — Today block` and `Tier 2 — Past-day block`). Tiers 3 (day rollups, 7–30 days) and 4 (week rollups with editorial summary, 30+ days) are deferred — implement when scrollback friction shows up in real use. The four-tier model below stands as the design; the rationale doesn't change.

Original timeline model had every past day render identically — compact cards under a quiet day header, scrolling continuously backward. Rejected once the feed accumulated real history because:

- **Scrollback becomes prohibitive.** A month is ~150 cards. Three months is ~450. The timeline is supposed to be reachable, not traversable only in long bursts.
- **Human memory doesn't work that way.** Yesterday is vivid. Last Tuesday is a blur. Three months ago is a date you'd have to think about. A design that renders yesterday and three-months-ago identically is fighting the actual mental model the user has of their own past.
- **The job of a card changes with depth.** Today's card is a poster. Yesterday's card is a reminder. A card from three weeks ago is a reference. A card from three months ago is a trace. The UI should reflect that.

Current model — four tiers, no visible boundaries:

1. **Today** — hero cards, per-section density, Eddy's voice on picks
2. **Recent past** (~7 days) — compact cards, quieter serif day headers, watched/recycled/gone states visible inline
3. **Middle past** (~7–30 days) — one row per day: thumbnail chip-stack + date + count + top creators. Tap expands inline into compact cards
4. **Deep past** (30+ days) — one row per week: date range + count + short editorial summary. Two taps to reach a specific video (week → day → card)

Scroll transitions are silent. No "Older" dividers, no tier labels — the gradient should feel continuous, with the cards themselves quietly shifting register. Month markers appear passively when the scroll crosses into a new month (italic label + hairline rule) as landmarks, not navigation.

Why this works for the project specifically:

- **Scarcity applies to attention spans too.** Making far-past content harder to graze through is consistent with the whole philosophy. You can reach any video ever added; the affordances favour today.
- **Drift's read is already visible in Tier 4.** A week row that says *"mostly Minecraft, some football"* is already the observation Drift makes. The timeline shows you; Drift interprets. Same data, different register. Avoids two surfaces that duplicate each other.
- **State concerns decay correctly.** Recycled and gone states matter most for recent cards. By Tier 3, a recycled item is a detail you access by expansion. By Tier 4, it's invisible — rightly, because at that depth the record is what matters, not the file state.

### Aggregation is render-time, expansion is inline

The database still has every card. Tiers 3 and 4 are purely visual — computed on scroll, not materialised. Tapping a week row expands inline into day rows; tapping a day row expands inline into compact cards. No navigation, no separate view, no modal. The scroll position stays.

This also means the tier boundaries (~7 days, ~30 days) are display rules, not data rules. They can be tuned without migrations.

### What Tier 4 summaries are allowed to say

Observational, never evaluative. *"Mostly Minecraft, some football"* — fine. *"A quiet week"* — fine when genuinely quiet. *"You should have watched more science"* — never. Gemma generates the summary at render time from the week's actual items; tone is restrained, factual, short. The voice is consistent with Eddy's picks voice but in third person (the week row isn't Eddy speaking *to* the kid, it's a description *of* the week).

---

## Why the person view is a reflective surface, not a discovery one

The person view is the page a user lands on when they tap a followed creator from the People tab in Profile (or, later, from a creator pill on a content card). The temptation when designing it is to make it a mini-feed — every video Eddy has ever pulled from this person, sortable, searchable, with "see all" affordances. Rejected.

A person view in Eddy is *reflective*: a quiet acknowledgement of the relationship the user has with this creator. Not a place to browse. Specifically:

- **Photo, name, bio.** Captured once from the channel about page (#41) and refreshed silently on RSS poll. Bio is shown if present, omitted if null — there is no "no bio" state, because the absence of a sentence isn't a story worth telling.
- **"Following since [Month YYYY]."** A single line of context. People remember when they started following someone the way they remember when they started reading a book; this is the line that makes the relationship feel real.
- **Up to 6 most-recent in-library items.** History-mode cards (watched flag visible inline). Reverse-chronological. No header label, no "see all," no pagination. Older items remain reachable via the timeline and Saved — the person view is not the surface for that traversal.
- **Support sources.** Direct support links (Patreon, Substack, Bandcamp, Ko-fi, Bookshop.org, merch) captured from the channel about page. Adults get tappable links; kids get plain-text labels from a fixed allowlist — they see *that* the creator is supportable, not a path off the family network. Anything outside the allowlist is hidden from kids entirely.
- **Unfollow.** Confirm modal: *"Stop following [Name]? You'll keep the videos you have. New uploads won't arrive."* The reassurance about kept videos matters — kids worry their library will be ransacked.

What the page deliberately does *not* do:

- **No browse-everything affordance.** Six items is enough to remind you who this creator is. More items would make the page a search surface, and search is a different surface in the app.
- **No play counts, watch percentages, ranked metrics.** Person-level transparency for kids is qualitative (Section 4a); the same restraint applies to adults here, because a leaderboard register is wrong for the relationship the page is trying to depict.
- **No "recommended by them" feed yet.** When recommendation extraction lands (Phase 5 close-out), it gets its own treatment — possibly inline, possibly its own surface. Not relitigated here.
- **No first-month emptiness handling.** A person you just followed renders thin but valid: bio + photo + follow line + whatever items exist (zero, one). No "loading" placeholder, no "come back later" copy. Thinness is fine.

The page exists so the user can confirm *"yes, this is the creator I follow, here's what's recent, here's how to support them, here's how to stop."* That's the whole brief.

---

## Why agents are infrastructure, not interface

A vision question came up: if everything is heading toward AI-native software, what does Eddy look like in a paradigm with no traditional apps? The plausible-sounding answer is per-person agents, conversation as the primary surface, the PWA dissolves. The plausible-sounding answer is wrong.

Eddy's second principle (Section 1) is to *replace the dopamine loop with something that earns its time*. A chat interface is dopamine-shaped by default — open-ended, lean-forward, infinite. A daily curated set of cards isn't. Putting an agent in front of the kid surface, however capable, would be turning Eddy into the thing it's designed to displace. Eddy is meant to be slower and more considered; a conversational primary surface would push the other way.

What changes as local models keep getting better is **what the existing modules can do**, not what surfaces exist:

- Discovery's `why_text` becomes more honest and more specific.
- The guard's reasoning gets richer — better borderline judgements, better appeal handling.
- Drift's weekly observations get more incisive.
- Balance prompts can detect more subtle patterns and phrase the offer better.
- Recommendation extraction reads followed people's text outputs more reliably.

None of that needs new architecture. Modules are TypeScript files (Section 4); a smarter Gemma changes the contents of a function call, not the shape of the system. There is no "Phase 12: go AI-native." The current build plan is already the AI-native plan; it just runs against better models over time.

People-as-subscription-unit and local-first get **more** load-bearing in this world, not less. As AI-generated content volume goes vertical, trusted human judgement becomes the only real differentiation — the people graph is where that trust lives. And kids'-data-never-leaves forces capable local inference, which is a constraint that ages well: a household-scale system whose intelligence improves on consumer hardware is the right shape for a privacy-first product.

The one conversational surface in Eddy stays where Section 13 already puts it — adult MCP via Claude.ai, gated by the privacy filter. That's lean-forward control-plane work where conversation is the right register. It's not a kid surface and won't become one.

### What "calm interjections" means

The agentic surface that *is* welcome is the existing interjection vocabulary, executed well: in-feed balance prompts, Drift weekly summaries, ntfy notifications for guard escalations and overrides, kid-readable rejection reasons with appeal. These are slow, specific, infrequent, and they don't expect a conversation back. New interjection types may earn a place over time, but each one has to be *quieter* than what came before, not chattier.

### Deferred

- **Reasoning loops vs. one-shot inference.** Current discovery and guard score per-item in batches. A future module might benefit from multi-step loops (search → evaluate → search differently → re-score; or borderline guard verdict → fetch channel context → re-score). If/when a specific module hits a wall that one-shot inference can't clear, revisit. Until then, no agent runtime is needed and the current batch-Gemma shape is correct.
- **Local-model capability ceiling on the M4.** The position above assumes Gemma-class-or-better keeps improving on consumer hardware. If that bet sours, Phase 11 frontier escalation (Section 9) is the existing fallback for the guard; broader frontier use would have to be reconciled with the kids'-data-never-leaves rule case by case. Not relitigated here.

---