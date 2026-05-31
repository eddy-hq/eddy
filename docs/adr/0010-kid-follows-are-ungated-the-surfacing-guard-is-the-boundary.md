# Kid follows are ungated; the surfacing guard is the kid-safety boundary

Issue #151 surfaces **Follow suggestions** — creators a user has watched or saved but does not follow — on the People tab, with a Follow action. For a kid profile this raised the question: should a kid following a creator require parent approval? Kid safety is the #1 non-negotiable ("default to escalation in the guard; never auto-approve uncertain content"), and the obvious reflex is to gate the act of following behind a PIN or an **Escalation**.

Three actor models were on the table: **(A)** kid initiates a follow → parent approves via an ntfy **Escalation** (a new `pending_follow` object on the **Signed-token** action pattern); **(B)** kid follows immediately, same as an adult; **(C)** the suggestions are parent-facing only — the kid never sees them and the parent follows on their behalf.

The decisive observation is that **a follow opens no unguarded pipe**. Every candidate a follow can generate — a new `subscription` upload, a back-catalog item, an inferred-interest search result — lands in `candidate_pool` and must pass `surfaceForToday`, which for a kid hard-requires `guard_verdict = 'clear_yes'` (`src/modules/discovery/surface.ts`; an un-rechecked candidate does not surface — default to escalation). This gate is live **now**, independent of the Phase 6 request-approval flip (which concerns share-sheet **Requests**, a separate path). Furthermore, every creator in the suggestion list is one the kid *already watched* — so each already cleared the guard at request time. Following changes only feed *weighting* and *composition* among candidates that have already earned `clear_yes`; it exposes the kid to nothing the guard won't independently vet.

The rule: **a kid following a creator is ungated. The per-item `clear_yes` surfacing gate — not the follow act — is the kid-safety boundary. A follow reweights and reorders already-cleared candidates; it never bypasses the guard.** This is consistent with [[0009-subscriptions-and-discovery-compose-one-slotted-slate]] ("following is no longer a guaranteed bypass") and [[0008-discovery-inputs-trace-to-a-human-act]] (the follow is the human act; safety is enforced downstream at surfacing).

## Consequences

- **`POST /people/follow` stays role-blind.** Kids and adults both follow immediately from the suggestion surface; there is no PIN, no `pending_follow`, no **Escalation** for the follow act. The endpoint is unchanged.
- **The kid-safety guarantee moves entirely to the surfacing step.** The invariant that protects a kid is `surfaceForToday`'s `guard_verdict = 'clear_yes'` requirement, which already covers every `source_type`. This ADR makes that the *named* boundary — changing it (e.g. letting un-rechecked candidates surface for kids) is the reversal that would make ungated follows unsafe.
- **A follow still amplifies** — it seeds inferred-interest derivation and back-catalog surfacing — but every amplified candidate is independently guarded before a kid sees it, so amplification carries no unguarded exposure.
- **No parental roster oversight by design.** A parent does not approve *who* their kid follows as a relationship. This is an accepted trade-off: the per-item guard is judged sufficient, and kid agency in building their own trusted-humans roster is judged worth keeping.
- **AFK-testable.** Because nothing about the follow path branches on role, the suggestion + follow logic is unit-testable without a kid profile; only the (unchanged) guard surfacing gate carries the kid-specific behaviour, already covered by `surface.test.ts`.

## Considered and rejected

- **(A) Kid initiates, parent approves via Escalation.** Rejected: it invents a `pending_follow` object and a signed-token approve/deny endpoint to guard an act that the surfacing gate already makes safe — machinery with no safety payoff. The established **Escalation** primitive is request-coupled; generalising it here is unjustified cost.
- **(C) Parent-facing suggestions only.** Rejected: zero kid agency — the kid cannot express "I want more of this person" — and it breaks the "below the people you follow on the People tab" surface for kid profiles. More paternalistic than the per-item guard warrants.
- **A PIN gate (the issue's literal wording).** Rejected: no PIN primitive exists anywhere in Eddy, and Eddy's parent-adjudication mechanism is the ntfy **Escalation**, not an on-device PIN. The issue's "PIN-gated" was loose language for "parent-approved", which (A) covers and this ADR declines.

## Deferred

- **Revisit if the per-item guard proves insufficient in practice.** The whole basis for ungated follows is that `clear_yes`-at-surfacing reliably protects a kid. If real-world guard quality (post-Phase 6) shows that following materially worsens a kid's exposure despite per-item gating, model (A) is the fallback — and the **Signed-token** + **Escalation** pattern is where it would be built.
- **Parental roster visibility (read-only).** Not the same as approval: a future parent view of "who Boy1 follows" with an unfollow affordance is compatible with this ADR and not built here.
