# Agents are infrastructure, not interface

By 2026 the AI-native default for a smart family media product is a conversational agent — open-ended chat in front of every user, lean-forward, infinite. Eddy doesn't have that surface and isn't going to. The kid's primary surface is a daily-curated set of cards; the adult's primary surface is the same plus a magazine-style read. The only planned conversational surface is the adults' control plane, an MCP server reached via Claude.ai and gated by the privacy filter (Section 13), where conversation is the right register for control-plane work. Neither is built yet.

The principle has two halves and they're inseparable. The rejected half: no chat in front of kids, no conversation-as-primary-surface for the daily read. Chat is dopamine-shaped by default — open-ended, lean-forward, infinite — and Eddy's second principle (Section 1) is to *replace* the dopamine loop, not import it under a smarter brand. The affirmed half: smart features go *inside* existing module shapes (the guard's reasoning, discovery's why_text, Drift's observations, the balance prompt) or as new *calm interjections* — slow, specific, infrequent, no expectation of a conversation back. Any new interjection type has to be quieter than what came before, not chattier.

## Consequences

- Conversation only on adult MCP. A new conversational surface is a violation regardless of how capable the model becomes.
- New smart features default to *interjection*, not *surface*. If a feature can't be expressed as something that fits inside an existing module or as a new calm interjection, the design wants reshaping before it's built.
- A smarter local model changes the *contents* of a function call (richer borderline judgements, more incisive Drift observations, better-phrased balance offers), not the shape of the surfaces. There is no "Phase 12: go AI-native"; the current build plan is already the AI-native plan, run against better models over time.

## Deferred

- **Reasoning loops vs one-shot inference.** Discovery and the guard score per-item in batches. A future module might benefit from multi-step loops (search → evaluate → re-search; borderline guard verdict → fetch channel context → re-score). Revisit if a specific module hits a wall one-shot inference can't clear.
- **Local-model capability ceiling on household hardware.** This ADR assumes small local models keep improving on consumer hardware. If that bet sours, the guard's fallback is the offline frontier teacher on public data ([[0014-guard-training-labels-come-from-a-frontier-teacher-on-a-public-pool]]); broader frontier use would have to be reconciled with [[0004-kids-consumption-stays-home]] case by case.
