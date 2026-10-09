# One notification channel

Eddy has one channel for every notification — guard escalations, override requests, "video ready", weekly Drift, pipeline alerts to the parent. No email, no SMS, no Web Push, no Pushover, no per-event-class routing. Today the implementation is ntfy self-hosted on the fetch box; the principle is one channel, regardless of which technology delivers it. *(Amended 2026-09-19: ntfy has been removed. Amended 2026-10-09: APNs push has shipped, and the event list above has been corrected — see the amendments below.)*

The single-channel discipline is the actually-load-bearing decision. The obvious failure mode is *"this guard escalation is urgent, let's also send email"* six months in — at which point notifications fragment, signed-token action endpoints have to handle multiple delivery shapes, kids learn that some channels can be ignored and others can't, and the household has three places to check. Forcing every event through one channel keeps the priority signal honest: `max` priority means something because nothing else competes for it.

ntfy specifically is a good fit right now (self-hosted, signed-token-friendly action buttons, no third-party account, works for kids without an App Store account), but the system is structured so the implementation can be swapped without violating the principle: everything in the codebase calls `notify(user_id, event, payload)`, and that's the only contract. A native iOS app with direct APNs is the most likely successor — when it lands, it replaces ntfy, it doesn't augment it.

## Consequences

- *(Superseded 2026-09-19.)* If ntfy.sh has an outage, urgent notifications wait. That's the price of the principle; no fallback channel is the right answer.
- Every action button in the system depends on the signed-token pattern surviving the channel swap. See [[0013-native-ios-is-a-thin-shell-with-apns-push]], which absorbed [[0005-single-use-signed-tokens]].
- *(Superseded 2026-09-19.)* Migrating to a native iOS app means re-pointing `notify()`, re-issuing topic credentials, and updating Shortcuts — the user-visible surface (events, priorities, actions) doesn't change.
- *(Superseded 2026-09-19.)* That migration is now specified: [[0013-native-ios-is-a-thin-shell-with-apns-push]] swaps ntfy for APNs, one user at a time, as a branch inside `notify()`. During the migration a user is on ntfy or on APNs, never both; when the last user has moved, ntfy comes out of the codebase. Replace, not augment — the rule above holds unchanged.

## Amendment — 2026-09-19: ntfy removed, transport is log-only until APNs

The principle is unchanged. One channel, everything calls `notify()`, replace never augment. What changed is the implementation: **ntfy came out of the codebase on 2026-09-19**, and it did not wait for a successor to be ready.

The evidence is the removal's whole argument. Nothing in the household used ntfy after the first week, and its TLS certificate expired on **2026-07-12** — so every send failed for ten weeks and nobody noticed. A channel whose total outage goes unremarked for ten weeks is not delivering notifications; it is costing a container, a certificate, a set of per-user credentials and a block of config to deliver nothing. Keeping it until APNs shipped would have preserved the appearance of a channel, not a channel.

**The interim transport is log-only.** `notify()` remains the single contract and every event is written to the structured log. Nothing is delivered to a device in the meantime, and nothing is added to cover the gap — a stopgap second channel is precisely the fragmentation this ADR exists to prevent.

**APNs via the native shell is the successor** ([[0013-native-ios-is-a-thin-shell-with-apns-push]]). It is now simply the first real transport behind `notify()`; there is no per-user cutover left to stage, because there is nothing to cut over from. The consequences above that turn on ntfy.sh's uptime and on a staged migration are superseded by this amendment. The signed-token consequence is not — it survives every channel swap, which was the point.

## Amendment — 2026-10-09: APNs push shipped

The principle held through the swap. APNs push via the native shell ([[0013-native-ios-is-a-thin-shell-with-apns-push]]) is now the one transport behind `notify()`, and it works on the household's iOS devices. When no APNs key is configured, `notify()` falls back to the log, as before; that is a missing transport, not a second channel.

"Replace, never augment" held on the other box too. The download worker's alerts reach the same single `notify()` through a signed internal relay rather than sending anything themselves.

The event list in the first paragraph was aspirational. The events `notify()` actually carries are: video ready, download alert, circuit open, failure streak, parent review, and decisions waiting. Override requests and a weekly Drift digest are not built. Data API quota exhaustion is log-only by decision; circuit-open and failure-streak alerts do notify.
