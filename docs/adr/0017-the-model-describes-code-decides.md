# The model describes; code decides; only an explicit clear-yes reaches a kid

**Status:** Accepted. Built for discovery candidates and the download-time second pass, behind `GUARD_CANDIDATE_PROMPT=v4`; discovery candidates are also calibrated (amended 2026-10-30). The code default is still `v3`. Kid requests and kid-typed interests still use the older verdict prompt, in shadow mode.

The first guard prompts asked a small local model for a verdict (`clear_yes`, `uncertain` or `clear_no`), a one-sentence reason and a confidence figure. That shape has two faults. The age limits live inside the model's head, so changing what a given age band may see means rewording a prompt and hoping. And the confidence figure is self-reported: it can't be thresholded, and nothing in Eddy ever used it to decide anything. A safety boundary needs a rule someone can read, test and version.

The rule: **the model describes a video and never judges it. It scores the rubric; a pure, versioned function turns those scores into a verdict for the kid's age band. A kid surface shows only an explicit `clear_yes`, and every failure lands short of one.**

**What the model returns.** For each of eight rubric dimensions (language, violence, frightening, sexual, substances, dangerous acts, commercial, attitude) a severity from 0 to 3. For each hard stop (self-harm, hate, sexualisation of children, misogyny as a worldview) `none`, `suspected` or `clear`. Two flags: adult-rated franchise and loot-box mechanics. And one short reason. No verdict, no confidence. The prompt asks it to score how strong the content is, not whether any child may watch it, and the age band is not in the prompt at all (`src/modules/guard/rubric-prompt.ts`).

**What code does with it.** `verdictFromScores` (`src/modules/guard/rubric.ts`) reads a per-band limits table:

- every dimension within its limit is `clear_yes`
- one level over on any dimension, or a suspected hard stop, is at best `uncertain`
- two or more levels over, or a clear hard stop, is `clear_no`
- flags can only tighten: discovery never surfaces a flagged video, and a request escalates or allows per band

Each step can only make the verdict stricter. A missing or unrecognised age band maps to the strictest band. The verdict carries the drivers that moved it off `clear_yes`, by rubric name and number, so a parent sees why without the model having said so. The rubric and its limits table share one version (`RUBRIC_VERSION`), the prompt is generated from the rubric and carries its own version, and every rubric-scored verdict records both.

**Failure never passes.** A model error, an unparseable answer or a throw is `uncertain`. Prompt truncation is turned off, so a prompt too long for the context window is an error, and so `uncertain`, rather than a silently cut rubric with a well-formed answer. A video the platform itself age-restricts is `clear_no` with no model call. Wherever the guard is enforced for a kid, `uncertain` parks the item as an Escalation; it is never shown while it waits.

**Only an explicit `clear_yes` surfaces.** `kidGuardClause` in `src/modules/discovery/surface.ts` requires `guard_verdict = 'clear_yes'` and excludes parent-blocked channels; a row that was never guarded has a null verdict and does not surface. This is the boundary [[0010-kid-follows-are-ungated-the-surfacing-guard-is-the-boundary]] names.

## Consequences

- **Age policy is a table, not a prompt.** Moving a limit is a one-line change with a test (`rubric.test.ts` fails if the code table drifts from `docs/guard-rubric.md`), and stored scores can be re-banded without asking the model again.
- **Scores are stored, not just verdicts.** `guard_eval.rubric_scores_json` keeps the scores, band, context and drivers. A stricter or looser rule can be replayed over past scores, which is how [[0015-the-guard-judges-safety-the-family-judges-taste]] showed that tightening the rules could not fix a label problem.
- **The same rubric serves every reader.** The guard prompt and the parent's reason chips read one versioned rubric, and the classifier track's teacher in [[0014-guard-training-labels-come-from-a-frontier-teacher-on-a-public-pool]] is designed to read the same one, so they can't drift apart.
- **The prompt's static prefix is shared.** The rubric sits first and per-video details last, so the model server reuses the cached prefix across a discovery run.
- **Two prompts coexist for now.** Discovery and the second pass use the rubric prompt when `GUARD_CANDIDATE_PROMPT=v4`; `v3`, a verdict-plus-confidence prompt, remains the code default and the fallback. Kid share-sheet requests and kid-typed interests still use a verdict prompt, but both run in shadow mode ([[0018-the-guard-goes-live-in-stages]]), so none of their verdicts decides what a kid sees.
- **A safety miss is a scoring miss.** If a video reaches a kid that shouldn't have, the question is which dimension the model under-scored, which the stored scores answer. It is never "the model felt confident".

## Considered and rejected

- **The model returns a verdict and a confidence.** The `v3` shape. Rejected: the limits are invisible and untestable, a band change means a prompt change, and the confidence is self-reported and uncalibrated. Kept only as the default until the switch is retired.
- **Per-kid thresholds.** Rejected: limits are per age band, so a sibling's settings follow from their age, and there is one table to read and test.
- **Fail open.** Treating a model error as a pass, or showing an unguarded item while the guard catches up. Rejected: kid safety defaults to escalation. A failure costs a pick, not a kid's exposure.
- **The age band in the prompt.** Rejected: it invites the model to apply its own idea of age-appropriateness on top of the table, so the same video would score differently for each kid and the stored scores couldn't be re-banded.

## Deferred

- **Retire `v3`.** Make the rubric prompt the code default and remove the switch once the harness ([[0019-guard-changes-must-beat-the-incumbent-on-replay]]) has nothing left to compare it with.
- **Kid requests and kid-typed interests** still use a verdict prompt. Moving them onto the rubric is undecided.

## Amended — 2026-10-30: calibrated scores on the discovery candidate guard

Calibrated scores were deferred: a score read from the model's token probabilities could be thresholded where a self-reported number can't. On 2026-10-18 a harness adapter (`gemma-v4.1-logprob`) began reading each dimension's distribution over 0–3 on replay, and `guard:harness -- calibrate` measured a threshold on the probability of a score over its limit. It is now built for the discovery candidate first pass.

The model still describes and code still decides. The rubric call for a discovery candidate also asks Ollama for token probabilities (same prompt, model, options and schema); `verdictFromScores` decides on the decoded scores exactly as before. Then p_over is the largest probability, over the eight dimensions, of a score above the kid's limit. A `clear_yes` with p_over at or above τ becomes `uncertain`, with the dimension and the numbers added to the reason a parent sees. Nothing else changes, so it only ever tightens. The token walk and the rule live in `src/modules/guard/calibration.ts`, which the harness replays through too.

**τ = 0.04**, chosen by [[0019-guard-changes-must-beat-the-incumbent-on-replay]]'s pre-registered rule on non-holdout (2026-10-30 amendment). On the holdout, the one honest test (166 safety-labelled items), Unsafe passed as `clear_yes` fell from 4/40 under the incumbent to 2/40, and clear-yes precision rose from 96.7% [91.7, 98.7] to 98.1% [93.3, 99.5] (Wilson 95%). On non-holdout, Unsafe passed fell from 13/106 to 9/106. The cost is escalations: the projected live uncertain rate for the candidate prompt goes from 4.8% to about 12.5%, roughly 21 candidates a day, so about one Escalation a day becomes about 2.6.

- **Fails closed.** A dimension whose probabilities can't be read counts as not provably under its limit, so the `clear_yes` escalates and a warning is logged; a systematic failure (an Ollama upgrade changing the logprobs shape) would show as every `clear_yes` escalating, not as anything passing. A failed or unparseable call is `uncertain`, as before.
- **Configurable.** `GUARD_CALIBRATION_TAU` takes a number in (0, 1] or `off`; unset means 0.04, so the stricter guard is the default. `off` restores the plain rubric guard exactly.
- **Recorded without a migration.** `rubric_scores_json` gains a `calibration` field (τ, p_over and the dimension reaching it) when calibration ran. `prompt_version` stays `candidate-v4.1`: the prompt hasn't changed.
- **Not calibrated:** the download-time second pass and kid requests and interests. The second pass reads a transcript and was not measured; requests are in shadow mode.
- **The harness keeps its plain baseline.** `gemma-v4` replays the rubric guard without τ under its unchanged id; the live configuration is "plain + τ", whose verdicts `calibrate` derives from the logprob adapter's results.
