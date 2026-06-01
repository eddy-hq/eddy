# Discovery inputs must trace to a human act

Every other recommender builds a behavioural model of you from what you watch and feeds it back — the closed loop of behaviour → profile → discovery → behaviour, with no human in it. That loop is the engagement spiral Eddy exists to replace (Section 1), and it is also where the user stops being the author of their own identity in the system. Eddy's **Interests** can arrive two ways — *declared* (the user typed it) or *inferred* (derived from the people they **Follow**). The decision is about what is allowed to **originate** a discovery input.

The rule: **every discovery input must trace to a human act — a declaration or a follow. Watch behaviour weights existing inputs and speaks in Drift, but never originates one.**

The principle has two halves and they're inseparable. The rejected half: no auto-promotion of an interest from watch behaviour, no inferred interest silently feeding discovery, no closed behaviour→discovery loop. The affirmed half: inferred interests are *proposals* — surfaced in the profile's "Eddy noticed" zone with explicit **Keep** / **Remove** — and they are **inert until kept**. A follow gives you that *person's* outputs (person-sourced **Candidates**); **Keep** is the additional human act that promotes the inferred interest to declared and licenses Eddy to hunt the broader *topic* via interest search. Following a person is not the same as asking Eddy to search the whole subject they represent.

## Consequences

- **Inferred interests are inert until kept.** A noticed-but-unkept interest is a proposal only; it does not feed the gap-filler search or the scoring vocabulary. Keeping it promotes it to a declared interest (the human act).
- **Declared and inferred are one primitive, two provenances — and the provenance is structural, not a column.** A *declared* interest is a stored `user_interests` row; an *inferred* interest is a live view derived from `follows → channel_interest_links → interests`, never auto-written to the profile. **Keep** is what writes — it inserts the inferred interest as a declared `user_interests` row. (An optional origin marker can record that a declared row was promoted from an inference, for Drift; not required for the mechanism.)
- **Behaviour weights but never deletes.** When watch behaviour disagrees with a declared interest (e.g. declared "Economics", but consistently skipped), the interest's runtime weight drops but the row stays. The disagreement surfaces in **Drift** as an observation, never as a silent profile edit.
- **Two-zone Interests editor.** Declared interests are a ranked, draggable list (priority is the input; weight = `1/sqrt(rank)`). Inferred interests sit in a separate "Eddy noticed" band, ordered by signal strength, with no rank — they cannot be interleaved into the ranked list because they have no rank.
- **Search-seed is decoupled from scoring-vocabulary.** A broad interest ("AI", "Running") serves as scoring vocabulary (connection axis) but generates no `ytsearch` query; search-term generation returns empty for interests too broad to yield good queries. This stops broad inferred-then-kept interests from polluting the gap-filler.
- **No mandatory onboarding gate.** The "≥1 interest and ≥1 follow to proceed" requirement is dropped. An empty "Picked for you" is a valid cold state, carried by the request flow until follows accumulate.
- **No kid/adult asymmetry.** The model is uniform across ages. A Minecraft-following kid gets inferred interests from imported subs; a request-flow-only kid simply has no inferred interests yet — not by special-casing, but as a natural consequence of having no follows.

## Considered and rejected

- **Auto-promotion from behaviour.** Watching a lot of X auto-adds X as an interest (the YouTube/TikTok default). Rejected: it is the capture loop by definition, and it makes the system, not the user, the author of the profile.
- **Inference replaces declaration** (the original framing of issue #150). Rejected: inference is structurally backward-looking — it can only reflect what you already follow and watch. Declaration is the only forward-looking input ("I want to get into woodworking"), and the only cold-start seed. The two are complementary, not redundant.

## Built since (Tier 2 inference — issue #181, 2026-05-31)

**Tier 2 inference is now built.** The deferral was tripped exactly as anticipated: a kid following ~28 Minecraft creators got the parent's adult seed topics (`economics`, `philosophy`, `news_analysis`) force-fit onto those channels, because `inferChannelInterests` could only *pick from the existing catalogue*. Specificity had drifted broad.

Inference now grows the vocabulary **bottom-up from content**, mirroring how a declared `user_added` interest is created on demand:

1. **Describe** — Gemma free-labels the channel's primary topic from its name + recent titles, unbiased by the catalogue (1–3 word label, or "unclear" ⇒ insert nothing).
2. **Canonicalise** — that free label is matched against the existing vocabulary on *semantic sameness* (not nearest-fit from a closed list, and explicitly allowed to find no match). This is the crux: it collapses "minecraft survival" / "MC redstone" onto one `minecraft` id, so the inferred-interest follower-count and the `MAX_PER_INTEREST` diversity cap keep aggregating correctly.
3. **Create on demand** — a genuine miss inserts a new `interests` row (`source='inferred'`) and enqueues the existing search-terms job. The new interest is still subject to every prior consequence: it is **inert until Kept**, and a kid's Keep still routes through the guard. So bottom-up vocabulary growth adds no kid-safety surface at inference time — the human-act boundary is unchanged.

The pre-seeded catalogue is therefore no longer a *forced* inference target. The seed rows that existed **only** as inference targets (declared by nobody) and were the leak fodder — `news_analysis`, `programming`, `camping` — were removed (migration 038); declared seeds stay. The add-interest browse grid (`GET /interests/`) was already unused and was removed; declared interests are added freeform (`/user-add`) or by Keeping an inference.

This supersedes the "Tier 2 inference" deferral below; the "specificity prompt at Keep" alternative remains unbuilt and unneeded for now.

## Deferred

- **Tier 2 inference — generating new vocabulary from content.** *(Built — see above.)* ~~Today inference only proposes interests already in the shared vocabulary~~ Generating a *new* interest label + `search_terms` from a channel's actual content was the **specificity** lever: inference could only ever be as specific as the declared vocabulary.
- **Specificity prompt at the Keep moment** ("Keep 'AI', or make it more specific?"). A cheaper partial alternative to Tier 2; deferred until drift is observed.
- **Backfill of pre-existing `channel_interest_links`.** The new inference applies to *future* follows; the stale links from the old force-fit prompt are left in place (one affected kid's were cleaned manually). Re-inferring the whole table is its own job.
