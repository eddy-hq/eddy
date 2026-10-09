# The guard goes live in stages, and its labels come from real parent decisions

**Status:** Accepted. Discovery surfacing and a kid's slate picks are enforced. A kid's own requests (from the share sheet or in-app search) and kid-typed interests are still scored in shadow mode; turning enforcement on for requests is next.

The plan was simple: run the guard in shadow mode, scoring every kid request while downloads went ahead regardless; label its verdicts by hand through a CLI; switch enforcement on once the labels showed the guard met three targets:

- **clear-yes precision ≥ 95%**: a wrong yes is unsafe content reaching a kid
- **clear-no precision ≥ 90%**: a wrong no is good content wrongly withheld
- **uncertain rate 10–30%**: higher overloads the parent, lower means the guard is overconfident

Two things broke the plan. Discovery arrived, and a kid's slate could not wait for the targets: a surfaced pick is something Eddy chose to put in front of a kid, not something the kid asked for. And the CLI labelling never became a habit, so almost no labels existed. Lowering the bar to fit the labels on hand was the obvious way out.

The rule: **enforcement goes live by source, as each source can be enforced safely, and never by relaxing the targets. The labels that measure the guard come from parent decisions made in the normal course of using Eddy, not from a separate labelling chore.**

**Discovery surfacing is enforced.** A kid sees only candidates with an explicit `clear_yes` ([[0017-the-model-describes-code-decides]]). An `uncertain` candidate is parked as an Escalation for a parent; a `clear_no` is rejected.

**A kid's slate picks are enforced after download.** A pick passed the candidate guard on metadata alone. When it downloads it lands in a hidden state (`guard_review`) and a second pass re-guards it with the captions that arrived with the download, so there is no extra upstream request and no quota ([[0012-downloads-are-budgeted-and-stop-when-blocked]]). Only `clear_yes` makes the card visible. A metadata yes that the transcript contradicts, a missing verdict or any failure parks the pick as an Escalation with its file kept. Missing captions mean a metadata-only pass, recorded as such. A video the platform age-restricts is `clear_no` with no model call. A blocked channel or a parent's block on that video is checked before the model call and again after it, so a block made while the guard ran still wins.

**A kid's other requests stay in shadow mode.** They are scored and logged, and the download goes ahead whatever the verdict. Kid-typed interests are scored the same way, with no effect. Enforcement for requests is next.

**Labels come from a Decisions surface.** It combines two streams:

- **Escalations:** the guard's parked `uncertain` items, shown with its verdict and reason. Answering one is a decision the parent had to make anyway.
- **Spot checks:** a small blind daily sample of the guard's clear verdicts, mostly `clear_yes` with some `clear_no`, drawn from the last week. The guard's verdict stays hidden until the parent answers.

A parent answers Allow, Unsafe or Not for us ([[0015-the-guard-judges-safety-the-family-judges-taste]]). The daily notification says only how many decisions are waiting: no titles, no channels. Each answer has its live effect at once and is recorded as a label about a video for a kid, apart from any one model run ([[0019-guard-changes-must-beat-the-incumbent-on-replay]]).

## Consequences

- **Enforcement is uneven, on purpose.** What Eddy chooses to show a kid is held to the guard now; what a kid asks for directly isn't yet. Until requests are enforced, a kid's share-sheet request can reach their feed with a `clear_no` on its record. That is the known gap, and it is the next stage.
- **Spot checks on shadow requests record a label only.** The video is already downloaded and visible; the answer measures the guard without changing the feed.
- **The parent's backlog is bounded.** The daily queue is capped, Escalations first, and older Escalations wait for a catch-up mode instead of piling onto today.
- **Labels accumulate as a side effect of use.** They arrive slowly, so a precision figure takes weeks to firm up, and catch-up sessions are how a parent speeds that.
- **Family decisions measure the guard; they never train it.** That boundary is [[0014-guard-training-labels-come-from-a-frontier-teacher-on-a-public-pool]]'s, and staging doesn't change it.

## Considered and rejected

- **Relax the thresholds** so enforcement could start on the labels that existed. Rejected: the targets are the definition of "safe enough", and moving them to fit thin data inverts the order.
- **Fetch a transcript for every candidate** before surfacing. Rejected: a transcript request per candidate multiplies upstream traffic for items most kids never see. The second pass gets the captions free with the download.
- **A third-party transcript service.** Rejected: it would receive video ids derived from a kid's interests, which is household data leaving home ([[0004-kids-consumption-stays-home]]).
- **Show the guard's verdict on a Spot check before the parent answers.** Rejected: it anchors the answer, and a label that agrees with the guard because it was shown the guard measures nothing.
- **Keep labelling through the CLI.** Rejected on the evidence: it didn't happen.

## Deferred

- **Enforce kid requests.** The next stage. How a held request reaches the parent is not yet built.
- **Per-item push for Escalations.** Not built; the daily count is the only nudge.
