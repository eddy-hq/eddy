# Kids' consumption never leaves the M4

In 2026, the default for kid-safety classification is to call a frontier model — Claude or GPT are meaningfully better at the task than anything that runs on consumer hardware. Eddy doesn't. Every piece of kid-facing inference — guard triage, discovery scoring, Drift observations, "why this?" generation — runs against a local model on the M4. Today that model is Gemma 4 E4B, served by Ollama. The model will be replaced as better ones ship that fit the hardware; the rule survives the replacement.

The principle is the load-bearing decision, not the model choice. Trust with the kids is the product (Section 1) — they will accept being looked-after, they will not accept being watched. Routing watch history, transcripts, or borderline judgements through a third-party API breaks that on the inside even if nothing visible changes. There's a second-order argument too: as AI-generated content volume goes vertical, trusted human judgement becomes the scarce resource. A household-scale system whose intelligence improves on consumer hardware is the right shape for a privacy-first product; one whose intelligence depends on a frontier API has a different posture and a different ceiling on what it can promise.

## Consequences

- Guard quality is bounded by what local models can do on the M4. Phases 3–5 run Gemma in shadow mode to measure the gap before the guard goes live in Phase 6.
- MCP responses pass through a privacy filter that strips kid real names (substituted with `kid_1` / `kid_2`) and any consumption detail (titles, creators, watch times). Tested with integration tests; failures throw rather than send.
- No cloud analytics, no external observability service touches kid behaviour. Logs containing kid events stay on the M4.
- The Phase 11 frontier escalation is deferred, not approved. The open question is whether uncertain guard cases can be routed to Claude *without* violating the rule — possibilities include parent-approved escalation on a per-case basis, or de-identified prompts. Not relitigated until ~200 parent decisions are in SQLite and the actual quality gap is visible.
- Adult MCP and adult Drift are *not* covered by this rule. Adults can use a frontier model against their own data if they choose to — the boundary is kids, not the household.
