# The guard judges safety; the family judges taste

Phase 6a's Decisions surface gave a parent two answers on any video: Allow or Block. The first guard harness replay (#220, 2026-10-02) scored today's v4 candidate prompt against those answers and reported a clear-yes precision of 51% against a target of ≥95%. Splitting the result showed the number was measuring two different things. Of the 169 items the guard approved and the parent blocked, 86 scored zero on every rubric dimension, and a look at those 86 found that most were not unsafe at all: 41 were one coaching channel's sales Shorts, and most of the rest were mainstream explainers, gaming and football creators the parent simply didn't want. About six were genuine safety misses, and every one was a knowledge gap rather than a judgement error: sexual slang in a game-mod title, an alcoholic drink brand, football card-pack openings.

A parent's Block meant either **unsafe for this kid** or **not for us**: quality, taste, relevance, a channel the family doesn't care for. The guard was being scored against both, and no threshold change could fix that. Re-deriving verdicts from the cached scores under stricter rules barely moved precision, because the model had correctly found nothing unsafe in videos the parent rejected for taste.

The rule: **the guard decides one question, whether a video is unsafe for this kid's age, and is measured only on that. Whether a video is right for this family is the parent's call, recorded as Not for us. It is a preference signal for the feed, never a guard label, and it never changes a profile or channel on its own.**

## Consequences

- **Block splits into Unsafe and Not for us** wherever a parent decides (#227). Both have exactly the live effect Block has today: the video leaves or never reaches that kid's feed. Only what the label means differs.
- **The eval measures the guard on Unsafe only.** The harness counts Unsafe as clear-no and leaves Not for us and unrecorded Blocks out of the safety metrics, reporting them separately. Existing Blocks carry no kind until the parent sets one in Review. This narrows [[0014-guard-training-labels-come-from-a-frontier-teacher-on-a-public-pool]]: household decisions are evaluation data, and from now on only their safety half is evidence about the guard.
- **The rubric stays a safety rubric.** Taste dimensions (quality, clickbait, "brainrot", sales content) are not added to the guard to win back precision. Its `commercial` dimension stays about advertising pressure on a child, not about whether the family likes sponsored content.
- **Not for us feeds the slate, under the existing guardrails.** It belongs with the negative ranking signals (player delete is already a strong negative). It may *suggest* a change, such as offering to block a channel after repeated Not for us answers (#228). It may never apply one without the parent's tap, consistent with the rule against auto-applying Drift suggestions or profile changes.
- **The parent's safety role remains, and narrows.** The guard's uncertain verdicts still go to the parent, as Escalations, and Spot checks still sample its approvals. With taste out of the measure, the remaining safety misses are knowledge gaps that a small local model is expected to have: slang, brands, niche gaming culture. These are the argument for the classifier track's frontier teacher and for a rubric glossary, not for making the parent the safety backstop for everything.
- **Kid-safety defaults don't change.** Splitting the label loosens nothing. Unsafe and Not for us both block, the guard still escalates when uncertain, and nothing here lets an uncertain item through.

## Considered and rejected

- **Teach the guard taste.** Add quality and relevance dimensions so the guard blocks what the parent dislikes. Rejected: taste is per family and changes week to week, a small model would learn this household's topics rather than any standard (the reason [[0014-guard-training-labels-come-from-a-frontier-teacher-on-a-public-pool]] keeps household labels out of training), and it would blur the one guarantee the guard exists to give.
- **Keep one Block and infer the kind from reason chips.** Rejected: chips are optional and rarely used (26 of the 169 replay disagreements had any), and the kind is the one thing the eval cannot do without.
- **Tighten the verdict rules until precision passes.** Rejected: on the cached replay scores no stricter rule reached the target. The strictest raised the live uncertain rate to 44% while leaving precision on hard cases at 35%, because the shortfall was in the labels' meaning, not the thresholds.

## Deferred

- **Not for us on the kid's feed as a parent sees it.** Today a parent meets most videos in Decisions, so that is where the split lands first. A parent noticing an unwanted video in a kid's feed is the more natural moment, and a feed-card action can come later.
- **Revisit if Unsafe-only precision still misses the target.** If the guard falls short against Unsafe labels alone, the gap is real safety error. The responses are then a better model, a richer input (transcript or thumbnail for candidates), or more escalation, in that order of preference.
