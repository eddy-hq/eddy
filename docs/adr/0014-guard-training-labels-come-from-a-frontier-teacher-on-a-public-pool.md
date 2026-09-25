# Guard training labels come from a frontier teacher on a public pool

The guard's long-term shape is a small local classifier — one head per **Rubric** dimension on a shared small backbone, the Luna-2 pattern — scoring content severities that the rubric's per-age-band limits table turns into a verdict. Training that student needs thousands of labels in the rubric's shape. The household cannot produce them: one parent labelling one family's traffic yields hundreds, skewed to whatever the kids watch this term, and a student trained on it learns their topics rather than the parent's standards. So training labels come from a **frontier model acting as an offline teacher**, labelling a **public pool** of YouTube videos against the rubric. The parent audits a sample of the teacher's labels (gold vs silver agreement) and the rubric is revised until agreement holds.

**The pool never touches Eddy's data.** It is sampled from public YouTube via the Data API, seeded from generic genre lists and public research datasets (Samba, Disturbed YouTube for Kids) — never from `candidate_pool`, `requests`, `guard_eval`, `user_interests`, or anything else derived from a household member. The pool builder does not import `src/db/client.ts`; the boundary is enforced by the code's dependency graph, not by convention. What reaches the frontier API is public metadata about public videos, with nothing that says who in the household might watch them. That is why this sits outside [[0004-kids-consumption-never-leaves-m4]] rather than bending it.

**Household decisions are evaluation data, never training data.** Parent **Escalation** and **Spot check** decisions measure every guard configuration — today's Gemma prompt, off-the-shelf floor models, the trained student — and later serve as retrieved precedents. They are never sent to the teacher and never used as gradient signal. A held-out slice is never used as precedent either, so the stack can be scored honestly.

**This is not runtime frontier use.** The teacher runs as an offline labelling job over public data. Runtime verdicts stay local (Gemma today, the student if it wins on the benchmark). Phase 11's runtime escalation to a frontier model remains separate, optional, and unaffected.

## Consequences

- **Train/serve parity constrains the pool.** The student can only use signals available at runtime. Candidates get transcripts only on a budgeted second pass ([[0012-ytdlp-exposure-is-budgeted-slate-bound-and-residential]]), so the pool is labelled on metadata throughout and on transcripts only for a subset, matching the runtime mix.
- **Pool transcripts cost yt-dlp exposure** and come out of the same residential budget. Collect them slowly or for a subset; never let pool building starve the kids' downloads.
- **The rubric becomes load-bearing.** The guard prompt, the teacher prompt, the parent's reason chips and the student's output heads all read one versioned rubric. Changing it means relabelling the pool (or the affected dimensions), so rubric versions are recorded on every label.
- **"No frontier model anywhere in Eddy" is no longer true.** The accurate claim is "no frontier model ever sees household data, and none runs at request time".

## Considered and rejected

- **Train on household labels.** Too few, one labeller, and overfits the kids' current topics. Kept for evaluation, where a few hundred labels are enough to measure precision within a few points.
- **Train on public research datasets directly.** Samba and Disturbed YouTube for Kids label for ages 1–5 and the Elsagate era; their "suitable" class excludes most of what a 10–13-year-old watches. Useful as hard positives in the pool and as a public floor benchmark, not as the label source.
- **A large local teacher.** The M4 has 16 GiB and already holds Gemma 4 E4B; no strong 27B+ open model fits alongside it. A rented GPU running an open model would keep everything self-controlled, but the frontier teacher on public data carries no household data and is simpler to run.
- **Hosted classifier APIs at runtime (Jev, Luna).** Kid requests would leave the M4. The Luna/Jev *shape* is the target; their hosted products are not.
