# One notification channel

Eddy has one channel for every notification — guard escalations, override requests, "video ready", weekly Drift, pipeline alerts to Steve. No email, no SMS, no Web Push, no Pushover, no per-event-class routing. Today the implementation is ntfy self-hosted on Ubuntu; the principle is one channel, regardless of which technology delivers it.

The single-channel discipline is the actually-load-bearing decision. The obvious failure mode is *"this guard escalation is urgent, let's also send email"* six months in — at which point notifications fragment, signed-token action endpoints have to handle multiple delivery shapes, kids learn that some channels can be ignored and others can't, and the household has three places to check. Forcing every event through one channel keeps the priority signal honest: `max` priority means something because nothing else competes for it.

ntfy specifically is a good fit right now (self-hosted, signed-token-friendly action buttons, no third-party account, works for kids without an App Store account), but the system is structured so the implementation can be swapped without violating the principle: everything in the codebase calls `notify(user_id, event, payload)`, and that's the only contract. A native iOS app with direct APNs is the most likely successor — when it lands, it replaces ntfy, it doesn't augment it.

## Consequences

- If ntfy.sh has an outage, urgent notifications wait. That's the price of the principle; no fallback channel is the right answer.
- Every action button in the system depends on the signed-token pattern surviving the channel swap. See [[0005-single-use-signed-tokens]].
- Migrating to a native iOS app means re-pointing `notify()`, re-issuing topic credentials, and updating Shortcuts — the user-visible surface (events, priorities, actions) doesn't change.
- That migration is now specified: [[0013-native-ios-is-a-thin-shell-apns-replaces-ntfy]] swaps ntfy for APNs, one user at a time, as a branch inside `notify()`. During the migration a user is on ntfy or on APNs, never both; when the last user has moved, ntfy comes out of the codebase. Replace, not augment — the rule above holds unchanged.
