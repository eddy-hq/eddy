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

---

## Why transparency for kids, with limits

The literacy principle says the long-term goal is a kid who understands their own media consumption better over time. That requires showing how the system works.

**Kids see:** their own topics/channels/durations (Layer 1), watch history via timeline (Layer 2 implicitly), "why this?" on every surfaced item, balance prompts.

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