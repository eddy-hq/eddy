# Guard changes must beat the incumbent on a replay of parent decisions

**Status:** Accepted. The harness is built, with one adapter: the rubric guard ([[0017-the-model-describes-code-decides]]). The rule applies to guard changes from now on; the switch to the rubric prompt was made before the harness existed, on a re-run of parked candidates.

A guard change (a new prompt, a rubric edit, a different model) is easy to judge by impression: run it on a handful of videos, like what comes back, ship it. On a kid-safety boundary that is how a regression gets in unnoticed. Once parent decisions existed ([[0018-the-guard-goes-live-in-stages]]), there was a better test: what would this configuration have said about the videos a parent has already judged?

The rule: **a guard configuration replaces the incumbent only if it beats it on a replay of parent decisions, measured on clear-yes precision, clear-no precision and the uncertain rate. The labels that replay is scored against are kept clean: append-only, stored apart from any model run, and free of anything the guard never judged.**

**The harness** (`src/modules/guard-harness/`) has three steps:

- **Snapshot** freezes parent decisions into a dataset. It runs on a read-only database connection, never writes to production and never runs migrations. Each item carries a best-effort reconstruction of the inputs the guard saw *when the parent decided*, including the kid's history with that channel cut off at that time. It is not exact: the snapshot reads current candidate and metadata fields, and channel history is counted from today's request rows, so a later metadata refresh or a deleted request can shift an input. Exact historical replay is future work.
- **Run** replays the dataset through a configuration. Adapters judge with no side effects: one model call per item and nothing written to any table. Results are cached by adapter id, which includes the prompt and rubric version, so an edit re-evaluates instead of resuming over stale results. An item the model never answered is retried, never cached as a verdict.
- **Report** scores verdicts against labels: counts and metrics only, never content, and nothing written to the repo ([[0004-kids-consumption-stays-home]]).

**Only safety labels count.** Allow is clear-yes. Unsafe is clear-no. Not for us, and an older Block with no kind recorded, are left out of the safety metrics and counted separately ([[0015-the-guard-judges-safety-the-family-judges-taste]]).

**A fixed holdout.** A salted hash of the decision id puts a stable 20% of decisions in a holdout, the same decisions in every snapshot whatever else the snapshot contains, so the test set doesn't shift as labels accumulate.

**Labels are kept clean at the source.** A parent decision is a label about a video for a kid, not about one model run: a video can carry several guard verdicts (the live one, re-runs, the second pass), so labels live in their own table (`guard_decisions`) and every configuration is scored against the same ones. When a parent changes their mind in Review, the change is a new revision (`guard_decision_revisions`); the first-pass answer stays as recorded, and the latest revision is the current label.

**Parent picks never become labels.** A video a parent sends to a kid skips the guard, because the parent's choice is the approval. It is excluded from Spot checks, from the harness's channel history and from every signal that reads a request as the kid's own interest. It still obeys blocked channels: a parent pick from a blocked channel is refused.

## Consequences

- **"Better" has a number.** A change argues from the three metrics on the same labels, not from examples.
- **The incumbent can fail the targets and still be the incumbent.** Beating it is the bar for replacement; meeting the targets in [[0018-the-guard-goes-live-in-stages]] is the bar for enforcing a new source. They are separate tests.
- **Household results are evidence for this household.** They measure the guard on one family's videos, so they decide changes here but are not a general benchmark. A benchmark anyone can check is meant to come from the public pool in [[0014-guard-training-labels-come-from-a-frontier-teacher-on-a-public-pool]].
- **Labels can be audited.** Because revisions never overwrite, the dataset carries both the first-pass answer and the current one, and how often a parent changed their mind is visible.
- **The same harness judges the classifier track.** A trained student, when one exists, is adopted on the same terms.

## Considered and rejected

- **Tune by impression.** Rejected: it can't see regressions on videos nobody re-checked.
- **Overwrite a label when the parent changes their mind.** Rejected: it loses the record of what the parent first said, and silently changes the test set under every earlier result.
- **Tie a label to the model run the parent was shown.** Rejected: one video carries several runs, and older candidate verdicts didn't record the kid. A label tied to one run can't score the next configuration.
- **Include parent picks as labels.** Rejected: the guard never judged them, so they measure nothing about it, and a parent's send isn't evidence of what the kid would have been shown.

## Deferred

- **More adapters.** Only the rubric guard is wired in; the older verdict prompt and off-the-shelf floor models are next.
- **Retrieved precedents.** Past decisions shown to the guard as examples are designed, not built. The holdout is never to be used as precedent, so it stays an honest test.

## Amended — 2026-10-18

The first Deferred list included scoring the holdout separately. The report now does: both the replay report and a new live report give every figure for the holdout and the rest beside the overall one, with Wilson 95% intervals throughout, so that item is no longer deferred.

Two gaps in the measurement are closed alongside it. Decided candidates whose candidate row had been pruned were dropped from the snapshot; `recover` now fetches their title and channel back from the Data API into a file beside the database, and the snapshot rebuilds them from it, marked as recovered inputs and reported separately, because a title or channel can have changed since the parent decided. And the report can now score the guard verdict each decision recorded at the time (`report --live`, no model calls), split by prompt family and label source. That report gives precision for clear verdicts only: escalations are all decided while clear verdicts are only sampled, so the uncertain rate is read from guard verdicts recorded over the last 14 days instead. Those include offline re-runs of the parked backlog, which write to the same table under the same prompt versions with nothing to tell them apart, so the report labels the figure as all recorded verdicts rather than live traffic alone. Nothing else in the decision changes.

## Amended — 2026-10-30: the calibration cap reads the live uncertain rate

The calibration rule (brief §22 step 2) picks τ* on non-holdout as the loosest threshold passing the fewest Unsafe items among those whose uncertain rate is at most a cap (20%). Until now that rate was read from the labelled items, and it is the wrong population: every escalation is decided but clear verdicts are only sampled, so labelled items over-represent escalations. Tagging a backlog of older Blocks on 2026-10-30 lifted the labelled incumbent's uncertain rate from 9.5% to 17.6% with no live verdict changing, and moved τ* from 0.04 to 0.3 by tightening the cap alone. The live candidate guard's uncertain rate over the same days was about 5%.

The cap now applies to a projected live rate: the live candidate prompt's uncertain share over the last 14 days of `guard_eval`, plus its clear-yes share times the fraction of audited clear-yes items (live verdict clear_yes, replayed clear_yes, non-holdout) whose p_over is at or above τ or unread. Those audits are drawn at random from what the live guard passed, so they stand in for live clear-yes traffic; calibration only ever turns a clear_yes into uncertain, so that is the whole change. Labels play no part in the projection. The cap, the minimum-Unsafe criterion, the tie-break and the single holdout test are unchanged. The `guard_eval` caveat in the 2026-10-18 amendment applies: offline re-runs count as live.

This change was made after seeing the 2026-10-30 sweep under the old rule, so it is not blind. It is recorded here before the new rule is run, and its τ* is adopted whatever it turns out to be.
