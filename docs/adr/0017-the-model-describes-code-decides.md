# The model describes; code decides; only an explicit clear-yes reaches a kid

**Status:** Accepted. Built for discovery candidates and the download-time second pass, behind `GUARD_CANDIDATE_PROMPT=v4`. The code default is still `v3`. Kid requests and kid-typed interests still use the older verdict prompt, in shadow mode.

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
- **Calibrated scores.** A score read from the model's token probabilities could be thresholded where a self-reported number can't. Not built.
