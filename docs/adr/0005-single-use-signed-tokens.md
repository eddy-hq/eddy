# Single-use signed tokens for notification actions

Every action button delivered in a notification — `[Approve]`, `[Deny]`, `[30 min]`, `[1 hour]`, `[Ask a grown-up]` — calls back into Eddy via a URL of the form `https://eddy.tail-xxxx.ts.net/action/{handler}?token={token}`. The token is a short-lived HMAC-SHA256 signature (1h TTL) carrying the user, the action, and the target ID. On hit, Eddy validates the signature and TTL, looks up the token in `used_tokens`, executes the handler if unused, marks it used, and returns either a confirmation page or a PWA deep-link.

The single-use enforcement (the `used_tokens` table, not just the TTL) is the load-bearing part. A standard signed-JWT-with-TTL pattern protects against tampering but not replay — within the hour, anyone who saw the URL can re-fire it. Replay matters here in a way it usually doesn't, because the actions have real-world consequences: approving a guard escalation, granting a kid 1 hour of unblocked YouTube, deciding an appeal. A stolen phone, a notification that leaks into a screenshot, a parent who taps twice — all need to resolve the same way: the second hit is rejected.

The second reason for this shape is channel-agnosticism. The action endpoint is the same whether the button is rendered by ntfy today or APNs in a native iOS app tomorrow — the channel delivers the URL; the endpoint validates the token. That makes the future iOS transition (see [[0003-one-notification-channel]]) a channel-layer swap, not an endpoint refactor. Anything richer (per-channel interactive payloads, channel-specific auth) would couple the action handlers to ntfy and have to be unwound.

## Consequences

- Every new action endpoint adds itself to the same `/action/{handler}` shape. No bespoke auth, no session check, no per-endpoint signing.
- The `used_tokens` table grows monotonically — prune rows older than 24h on a schedule. Tokens are TTL'd at 1h, so 24h is the safety margin for clock skew and deferred taps.
- A parent who genuinely needs to approve the same item twice (rare) has to be re-prompted with a fresh notification, not given a re-usable URL.
