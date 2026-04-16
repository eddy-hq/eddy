# Eddy — Decisions & Rationale

Context, trade-offs and reasoning behind the choices in `brief.md`. Not a spec — read the brief for what to build. Read this when you want to know *why*, or when you're considering changing something and want to know what the original thinking was.

---

## Why single-process, not microservices

Four services on ports 3001-3005 was the original shape. Collapsed to a modular monolith with two process entry points (M4 API, Ubuntu worker) because:

- Household scale (4 users) doesn't need service boundaries
- Integration tax at assembly time is real and compounds
- Debugging across network hops is harder than across function calls
- Module boundaries are enforceable with TypeScript files + import rules
- One log stream to tail

The two processes exist for physical reasons (WiFi vs Ethernet, memory pressure on M4), not architectural taste.

---

## Why Ubuntu owns downloads, M4 owns reasoning

M4 is in the back room on WiFi. Ubuntu is next to the router on Ethernet. If downloads ran on the M4:
- Video crosses WiFi twice (YouTube → M4, M4 → Ubuntu SSD)
- Second hop competes with first for airtime, roughly halving bandwidth
- ffmpeg competes with Gemma (9.6GB resident) for 16GB RAM

Moving downloads to Ubuntu makes the path single-hop on Ethernet and frees the M4 for inference + PWA serving.

Side benefit: Gemma inference stays fast because it's not swapping against ffmpeg.

---

## Why yt-dlp directly, not Tube Archivist

TA is yt-dlp with operational scaffolding (scheduling, UI, retention). It doesn't protect against YouTube breaking changes — same engine underneath.

Going direct:
- We were already building most of the operational layer (queue UI, retry logic, scheduling) for the PWA anyway
- One fewer service, simpler architecture
- Eddy owns the file directory cleanly (TA expects to own its own)
- `seen_videos` table replaces TA's internal deduplication — trivial

The real reliability work is keeping yt-dlp and the PO Token plugin updated weekly. That's operational, not architectural.

---

## Why PO Token plugin, not throwaway cookies

YouTube has been progressively gating downloads behind PO Tokens (cryptographic attestation). Two paths:

**Cookies from a throwaway account:** works for many cases, but:
- Account rotation (YouTube can ban accounts doing server-side downloads)
- Requires storing Google credentials on Ubuntu — violates privacy principle
- More rate-limit exposure

**PO Token plugin (bgutil-ytdlp-pot-provider):**
- Anonymous, no Google account
- Handles attestation transparently via bundled Node.js runner
- Recommended by yt-dlp wiki
- Kids' downloads stay anonymous — age-restricted content fails, which is the *right* outcome (turns into a kid-readable rejection with appeal path)

An adult code path with throwaway cookies for age-restricted content may come later — separate from the kids' path.

---

## Why ntfy, not Pushover or PWA Web Push

Three options considered:

**PWA Web Push:** iOS 16.4+ supports it, but:
- Storage clears after ~7 days inactivity
- Action buttons patchy/unreliable
- Can't bypass DND/Focus modes
- Parents are the users most likely to have inactive PWAs, and parent approvals are the most time-sensitive events

**Pushover:** paid (~£16 one-time), rock-solid APNs, but:
- No proper lock-screen action buttons — just "supplementary URLs" that open Safari
- Parent approval UX becomes: expand notification → tap link → Safari opens → action runs
- Notification content transits Pushover's servers (privacy line)

**ntfy self-hosted:** chosen.
- Free, self-hosted on Ubuntu
- Proper HTTP action buttons
- Message content stays on Ubuntu (only opaque poll-request IDs transit ntfy.sh for APNs)
- Per-user topics with ACL
- Swap-ready interface means native iOS (v2) cleanly replaces it with direct APNs

Known caveat: depends on ntfy.sh upstream for APNs forwarding. Uptime has been good. Native iOS (v2) removes this dependency.

---

## Why Swift, not React Native (for the eventual native app)

Household is iOS-only. The three things driving the native-app pressure all benefit from deep iOS integration:

1. **Request flow quality** — deep-link handler (`eddy://`) makes Shortcut taps feel instant
2. **Notification reliability** — direct APNs, proper lock-screen actions, DND bypass
3. **Shortcuts integration** — App Intents + proper share extension, both iOS-only concepts

React Native would:
- Pay cross-platform tax for a single-platform problem (no Android to future-proof against)
- Still require Swift for share extension and App Intents
- Bridge notification handling awkwardly

Swift + SwiftUI is the right choice when it ships.

---

## Why TestFlight-only distribution (for the eventual native app)

App Store has two problems:

1. **YouTube policing.** Apple has approved YouTube-adjacent apps historically, occasionally pulled them when Google complains. TestFlight is considered pre-release and not meaningfully policed for third-party ToS compliance.
2. **Framing tax.** Public listing requires marketing copy, screenshots, ASO — effort against a need that doesn't exist. Eddy shouldn't be public.

TestFlight:
- 100-tester limit — irrelevant for a family of 4
- 90-day re-invite — single button click
- £79/year Apple Developer fee — modest
- Open-source + per-household builds — anyone self-hosting stands up their own Apple Developer account. Consistent with the self-hosted ethos.

Naming/framing in the app code stays generic: "Eddy", `hq.eddy.app` bundle ID, family/curation/literacy language. Not defensive — accurate.

---

## Why the feed is a forever timeline, not a queue

Original design had watched videos disappearing within 24h. Changed when we noticed:

- The kid has no visual record of their own week — breaks literacy goal
- Watching becomes punished ("the thing you wanted disappears") — wrong incentive
- Re-watches and sibling-sharing are real use cases

Current model: records persist forever, files are recycled under storage pressure. Recycled cards show a restore affordance — one tap re-downloads. Original guard verdict preserved, no re-triage.

This is why `added_at` anchors timeline position and never moves. The feed is *what was offered to me*; Drift is *what did I do with it*. Separate questions, separate surfaces.

---

## Why Drift, not a score

"Current" was the original name. Dropped because:

- Ambiguous with the English adjective ("your current score is 42")
- Too competitive — implies optimisation target
- Would get gamed by a 12-year-old

"Drift" preserves the eddy metaphor without the ambiguity. It's a weekly *mirror*, not a score. No number, no target, no week-on-week comparison. Optional streak counter tracks topic diversity (stretching) rather than volume (concentration).

The transparency principle: every row taps through to the evidence in the timeline. Drift is a guided tour of a week the kid can already see.

---

## Why scarcity as a feature

Recommendation engines default to maximising candidate pool and letting ranking sort it out — more candidates = more chances to hook. Eddy does the opposite:

- Small candidate pool
- High bar for inclusion
- Daily cap firm (kids 3-5, adults 10-20)
- Surplus carries forward, never inflates today
- "That's it for today — more tomorrow" at the bottom, not infinite scroll

Finishing "Picked for you" is a valid state. This is the explicit counterweight to the engagement-engine pattern the whole system is designed against.

---

## Why balance as a choice, not an imposition

When concentration is pronounced (>70% one topic), original design had discovery silently deprioritise that topic. Changed to surface as an in-feed prompt:

> *"You've watched a lot of Minecraft recently. Want today's picks to stretch you a bit, or stay in the groove?"*
> [Stretch me] [Stay in the groove]

Because:
- Preserves user agency
- Teaches the balance concept in the moment
- Both options are good content — Eddy isn't deciding what's good for you, it's offering a choice
- Kids learn to notice their own patterns in real time

Rate-limited to at most once per 1-2 weeks. Rare enough to feel meaningful, not a recurring UI pattern.

---

## Why no YouTube Data API for discovery

Better signal than yt-dlp scraping, free tier is plenty for household scale. Not using because:

- Requires Google Cloud project and API key
- Adds a Google entanglement the architecture has otherwise avoided
- yt-dlp topic search + related-channel expansion is sufficient for v1
- If discovery quality proves thin, this is the first thing to reconsider

Kept out of v1 as an "explicitly not using" rather than "planned for later" to make the decision visible.

---

## Why inferred affinities are internal v1

Layer 3 of the profile — Gemma-generated sentences describing shape of preference — is stored but not exposed in UI v1. Because:

- Confidence is low early; sentences could be noise or wrong
- Exposing them to kids risks them gaming the system
- "Why this?" surfaces Layer 3 *indirectly* on each discovery pick, which is richer signal than the raw sentences

Adults may get a private-mirror view of their own Layer 3 in a later phase. Kids probably never see raw Layer 3 — they get the "why this?" form instead.

(Note: after the people-first reframe, the profile has four layers — explicit, behavioural, person trust, inferred affinities. The reasoning here applies to the inferred-affinities layer specifically.)

---

## Why transparency for kids, with limits

The literacy principle says the long-term goal is a kid who understands their own media consumption better over time. That requires showing how the system works.

**Kids see:** their own topics/people followed/durations (Layer 1), watch history via timeline (Layer 2 implicitly), "why this?" on every surfaced item, balance prompts.

**Kids don't see:** hard exclusions (gaming risk if exposed), parent notes, raw confidence numbers, full Gemma reasoning on clear-no rejections, pipeline/queue internals.

The split is about what helps them understand themselves (transparent) vs what helps them game the system (hidden). Not paternalism for its own sake.

---

## Why the DNS-block landing page matters more than the block

Pi-hole's purpose in Eddy isn't to wall off YouTube. It's to *redirect* attempted YouTube visits into the Eddy request flow. Every blocked lookup resolves to a local nginx page:

> *"Open this in Eddy?"* [URL prefilled, one tap submits]

This turns the block from a wall into a routing mechanism. Kid taps YouTube link without share-sheet → landing page → Eddy handles it. Over time, the share-sheet becomes habit because it's the shorter path.

This is also why blocking being gated on partner buy-in doesn't block the rest of the system from being useful — the share-sheet path works fine without blocking.

---

## Why no Android path

Household is iOS-only. "Future-proofing for Android" is a cost paid against a need that may never arrive. Any v2 native work is iOS-specific (Swift) for this reason.

If the household or circumstances change, revisit.

---

## Why open-source post-Phase 5

Eddy solves a universal problem. Community improvements to the guard prompts, discovery sources, and profile system would help more families than solo development could.

Waiting until post-Phase 5 because:
- Need enough of the system shipped to be evaluable
- Need real usage data to know what's worth hardening vs what's still in flux
- Drift (Phase 5) is the most novel surface and where the architecture earns its keep

The per-household native build model (each household runs its own Apple Developer account) is philosophically consistent — Eddy is self-hosted by design, and the native shell follows.

---

## Why people, not channels, as the subscription unit

This is the most significant architectural reframing since the original brief.

Original design had users subscribing to *channels* (YouTube), *RSS feeds* (articles), *podcast shows*, and treating each as a separate surface. That mirrors the structure of the underlying platforms — but the underlying platforms aren't the right abstraction for what Eddy is trying to do.

**The underlying shift:**

As AI-generated content volume goes vertical across every channel, the scarce resource stops being content and starts being *trusted human judgement*. When topic-search returns a mountain of competent-but-soulless content, the signal that matters is "X thinks this is worth your time" — because X is a human with a reputation that degrades if they recommend slop.

People will increasingly organise their media diet around specific humans whose taste they trust. This is already happening: Substack loyalty is writer-driven, podcast loyalty is host-driven, book recommendations that move the needle come from specific named people. The platforms are already being worked around.

Eddy should be built for the world that's coming, not the world of 2015.

**What changes:**

- Subscribe to a *person*, not a channel/feed/show. A person has outputs (YouTube, Substack, podcast, books).
- Gemma's job is routing between people you trust and you — not deciding what's good. The people already did that.
- "Why this?" reasoning routes through person attribution wherever possible — "Tyler recommended this twice" is a more honest and more useful explanation than "matches your profile."
- Profile gains a person-trust layer — completion rate per person, per output, across media.

**What stays:**

- All existing fetchers (YouTube RSS, podcast RSS, etc.) — they become implementation details of person outputs rather than user-facing subscriptions
- The guard, the scarcity model, the timeline anchor, the feed structure — all preserved
- For kids in v1, a "person" is effectively a YouTube channel — mechanics don't change, framing does

**What this enables downstream:**

- Recommendations from people (not just their own outputs) — Tyler's book picks, Dwarkesh's podcast guests, Substack links
- Coherent discovery across media types without separate subscription concepts
- Direct creator support as a natural surface (people have support links; feeds don't)
- Books as a content type falls out naturally — books are what some followed people write and others recommend

**The literacy dimension:**

This is the most important part, and underpowered in a pure UX argument.

"Being intentional about who influences you" is a different life skill to "managing screen time" or "avoiding bad content." It's the skill of noticing whose voice is in your head, and choosing that deliberately. Most adults lack it. Most media literacy curricula don't teach it.

Eddy organised around people makes the influence relationship visible and named. Over years of use, a kid accumulates a record of who they chose to follow, when, and for how long. Drift can reflect that back qualitatively. The "unfollow" action becomes meaningful — not "remove this channel" but "I'm done with this person."

The long-term value of Eddy is less about any single feature and more about kids reaching adulthood able to name the humans shaping their worldview, notice when those humans change, and choose deliberately. Everything else in the system — guard, scarcity, discovery, extraction — is in service of that.

**What's deliberately excluded:**

- No social graph, no mutual-follow, no "who else follows X"
- No reputation scores visible to users
- No payment processing in Eddy (see separate entry)
- Kids don't get cross-media following in v1 — their outputs per person are effectively YouTube-only, to keep the surface thin

**Why the asymmetry between kids and adults is okay:**

Kids don't yet have a stable roster of trusted humans; they're forming those relationships. The "follow a person" action is small for them (it's still just subscribing to a YouTube channel) but the *framing* sets up the mental model they'll grow into. By the time Son 1 is 15, the infrastructure for following a writer's Substack or a podcast is already there. He grows into the product.

**Where this could be wrong:**

- Recommendation detection from text outputs (Gemma extracting "book X by author Y" from a blog post) may produce noisy results. Mitigated by making this one signal among many; if it's poor, fall back to "new outputs only" for followed-person discovery. Flagged as open question in brief.
- Kids may find following-a-person more abstract than following-a-channel, because the channel *is* concretely the thing they watch. Mitigated by keeping v1 kid UI close to channel-mental-model, with person-framing emerging through Drift observations over time rather than front-loaded.

---

## Why partial extraction for recipes only, not articles generally

When considering whether to ingest article content into Eddy (vs link-out), the tempting answer is "extract everything — better UX, consistent typography, no ads." The better answer is "mostly link-out."

**Why link-out is strong for articles:**

Safari Reader already exists and is excellent. iOS Reader Mode has had a decade of polish — it handles paywalls, embedded tweets, image galleries, footnotes, pull quotes, code blocks, math notation. Any extraction pipeline Eddy builds would be a worse version of something the OS ships free.

Link-out also preserves the author relationship. When someone reads an article in Safari, the site gets the visit, can offer a newsletter signup, see their traffic. Extraction reframes someone else's work inside Eddy's chrome. Ethically fine at household scale; still worth noticing.

Extraction is also where bugs live. Schema.org markup is inconsistent across sites. Readability produces subtly wrong output on edge cases. Once it's wrong once in a way that matters, trust in the extraction is broken.

**Why recipes are the one exception:**

Food blogs are structurally hostile to readers in a way general articles aren't. The recipe is buried under 1500 words of personal essay (deliberately, for SEO). Readability's summary extraction gives you the essay, not the recipe. Safari Reader handles this badly for the same reason.

But food blogs *reliably* publish `Recipe` JSON-LD markup — Google rewards it, so nearly all of them do. The author has already published the recipe as structured data. Eddy can render that structured data as the card interior, leaving the essay alone.

This is the opposite of general article extraction. It's not "try to be a better reader than Safari" — it's "use the author's own structured data to skip the cruft they wrapped it in for SEO reasons." The trade is fair.

**The heuristic for future extensions:**

Partial extraction works when **the author published structured data as part of SEO or platform conventions**, and the prose wrapper is incidental. Recipes, events (`Event` markup), products (`Product` markup), papers (arXiv metadata), HowTo — all cases where authors *want* the data extractable.

It fails when the prose *is* the content. Essays, journalism, opinion, narrative reviews. Link out.

v1 ships recipes only. Other schema types added if specific need emerges (events might be next, tied to holidays-with-partner use case). Not building a general extractor.

**Why this is worth a decision entry:**

The default AI instinct is to suck everything in. "Bring it all into the app" feels like good UX but is mostly the engagement-engine instinct in disguise. Eddy's whole premise is that leaving the app is fine. Recipes are specifically where leaving-the-app fails users (not just the app), and the fix is narrow and testable.

---

## Why podcasts are discovery-only, not subscription

The original brief had podcasts as a media type alongside articles and papers — user subscribes to a show's RSS feed, Eddy surfaces new episodes. Changed after noticing the structural problem.

**What podcast apps already do well:**

Apple Podcasts, Overcast, Pocket Casts all handle subscription-to-new-episode flow excellently. New episode badges, automatic downloads, queue management, cross-device sync, CarPlay, AirPods gestures, speed control, sleep timers. None of that is replicable in Eddy, especially in a PWA.

If a user is already following a show in their podcast app, Eddy re-surfacing new episodes is noise. It duplicates a notification they already got.

**What podcast apps fail at:**

Discovery. Podcast app discovery is terrible — chart-based, show-level, algorithmic in the bad way. Episode-level discovery across the whole podcast ecosystem is unsolved. "Find me a single great episode from a show I don't follow, on a topic I care about" is where the value is.

**The reframe:**

Podcasts are discovery-only in Eddy. No subscription model. The user has a curated list of ~50 high-quality podcasts across their topics (seed + expand). Gemma scores each new episode against the user's profile using title, category, and show notes. Three-bucket classification:

- Clear match → surface with "why this?"
- Clear reject → drop silently
- Uncertain → drop silently (not escalate; episodes are ephemeral, the cost of missing one is zero experienced cost, the cost of surfacing a dud erodes trust)

Tap → user's preferred podcast app via deep link.

**Why this fits the people-first reframe:**

Podcast episodes where the guest is someone the user follows get a heavy positive signal. Following Tyler Cowen means his podcast appearances get surfaced regardless of which show he's on. The subscription unit is still the person; the podcast curated list is a secondary mechanism for catching episodes where the *topic* is worth it even without a guest-match.

**Why "no signal is fine" is the right posture:**

For kid request-guard, the cost of an uncertain-decision being wrong is high (kid re-asks, friction, the item persists). For podcast discovery, the cost of a false negative is zero experienced cost (the user never knew they were missing it). This justifies aggressive silence on uncertainty. Episode metadata is often weak signal; Eddy shouldn't pretend otherwise.

Log all verdicts (including rejects and uncertains) for later evaluation. Same pattern as `guard_eval`. Without that log, tuning is blind.

---

## Why direct payment processing is not in Eddy

The ethical instinct is right: if Eddy organises attention around specific humans, closing the loop by paying them fits the values — undercuts the ad-supported engagement model, respects creator labour, makes following someone a meaningful commitment.

But there are two versions of "supporting creators from Eddy," and only one of them fits.

**Version A: Surfacing support links.** Every person card shows their existing direct-support infrastructure — Substack subscription, Patreon, Bookshop.org affiliate, Bandcamp, Ko-fi, author Amazon page. Eddy makes the path visible. User taps through to the creator's own existing payment surface. Eddy doesn't touch money.

**Version B: Integrated payment processing.** Eddy holds a budget, disburses micro-payments to creators, handles failures, reconciliation, tax. Eddy becomes a money transmitter.

Version B is roughly a different product. It requires:

- Payment processor integration (Stripe Connect or similar)
- KYC and AML compliance in multiple jurisdictions
- Tax reporting obligations
- Dispute handling
- Creator onboarding (they have to *receive* the money somewhere)
- Aggregator minimums and fee structures that eat most of the value at micro-payment scale

None of that fits a household-scale self-hosted project. The regulatory overhead would dwarf the rest of Eddy combined.

Version A captures ~90% of the ethical value at ~5% of the complexity. The creator gets paid through infrastructure they already trust. The "Eddy makes it easy to support the humans you follow" signal is real. User still has to take the action — which is appropriate; supporting a creator should be a deliberate act, not a frictionless tap.

**The deferred nice-to-have:**

A later-phase budget/allocation feature — at year-end, Eddy shows *"You finished 23 episodes with Dwarkesh this year; here are his support links"* with an invitation to allocate. Eddy still doesn't process money; it reflects attention back as a prompt to close the loop. Worth doing eventually. Not a phase, not a commitment — logged in "out of scope for v1" as a known-good idea deferred.

**Why this is worth writing down:**

This is exactly the kind of idea that gets scope-crept in later. "Wouldn't it be nice if Eddy could just process the payment?" Yes, it would, and also no, because that's a financial services company and Eddy is a family media system. Keeping the distinction sharp in the decisions log protects future-Eddy from the temptation.