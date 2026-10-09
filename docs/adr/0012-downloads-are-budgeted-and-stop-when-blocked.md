# Downloads are budgeted, demand-driven, and stop when blocked

After [[0011-discovery-metadata-via-data-api]] moved metadata reads to the Data API, downloads are the only meaningful yt-dlp traffic Eddy sends from the household's address. The July 2026 incident showed the remaining machinery still loses to a determined block: the block lasted three days whatever changed, and the escalating cooldown's twelve-hourly expiry probe (each one re-tripping and re-arming) at best delayed recovery and at worst kept the block alive. Meanwhile the database showed the real demand shape: downloads were outpacing viewing roughly ten to one, and most of the downloads stuck behind the block were eager fetches of follow uploads nobody had asked to watch.

The decision is a cluster that only makes sense together — **downloads are demand-driven and budgeted, the pipeline surrenders early when blocked, and the response to a block is less traffic, not different traffic**:

1. **Slate-bound downloads, follows included.** A follow upload enters the candidate pool when it is polled, but bytes move only when the daily slate selects the video (or a kid explicitly requests it). This extends [[0009-subscriptions-and-discovery-compose-one-slotted-slate]]'s "follows wait for the slate" from surfacing to *fetching*. Eager pre-fetch of every upload from every followed channel was the dominant volume driver.
2. **Global download budget of 10/day**, priority-ordered: slate-bound videos first, follow-sourced picks second. Back-catalogue seeding is under **full moratorium** — the pool-to-consumption ratio (10:1) says depth is a luxury already banked. *(Amended 2026-07-23: the global budget is 30/day and is now paired with a per-user cap of 10/day — see the amendment below.)*
3. **Circuit breaker over endless cooldown.** After 3 consecutive bot-detection re-trips, both yt-dlp-touching queues auto-pause (the `pipeline-pause` lever) and the parent gets one alert. Resume is always manual, via a dual-path probe (the inference box's anonymous path *and* the worker's download path — a clear anonymous probe does not prove the download path is clear). Dark-until-manual is chosen over autonomous backoff because past a day of consecutive blocks every automated probe has negative expected value: it can only refresh the block.
4. **No VPN, proxy or rented egress.** The right response to a block is less traffic, not different traffic. The block's blast radius is Eddy alone — the family's own browsers and apps are unaffected — so there is nothing to route around. Revisit only if outages become weekly rather than quarterly.
5. **No cookies, ever, including as break-glass.** A throwaway account under bot suspicion gets banned rather than rate-limited, converting a self-healing outage into a dead credential with a maintenance burden — and cookies on the kids' download path cross the anonymity line the brief draws (§256). When a block hits despite the above, the pipeline is simply dark until the block decays and the family lives off the pool. *(Narrowed 2026-07-20 — see the amendment below.)*

## Consequences

- A kid tapping into a followed channel's brand-new upload before the slate picks it hits "not downloaded yet" and waits minutes for an on-demand fetch, instead of instant play. This is the accepted cost of making the budget arithmetically honest.
- The candidate pool grows slower; a newly declared interest takes an extra day or two to gain depth. The existing pool absorbs this.
- Recovery from a block requires the operator. If they are away for a week, the pipeline stays dark even if the block cleared on day two — chosen deliberately over autonomous probing.
- On resume after a pause, parked download jobs are cleared rather than drained: queue jobs removed, their request rows moved to a non-destructive state so slate composition can re-select them under the budget. No backlog burst the moment a block clears.

## Considered and rejected

- **VPN, proxy or rented egress for yt-dlp.** Adds cost and an infrastructure dependency, changes the shape of the traffic rather than the amount, and protects nothing the block actually threatens (family YouTube use is unaffected).
- **Autonomous exponential probe backoff (24h → 48h → 96h).** Stays hands-off but keeps spending probes against a block whose length is unknown; the probes themselves are the suspected refresher. Manual resume with a good alert is cheaper and safer.
- **Throwaway-*account* cookies as a blocked-state fallback.** A *logged-in* account under bot suspicion gets banned rather than rate-limited, and account cookies on the kids' download path cross the anonymity line the brief draws (§256). Still rejected, and so are self-refreshing logged-in cookies, for the same reason.
- **Keep eager follow downloads, budget only discovery.** The stuck-queue autopsy showed follows *are* the volume; budgeting around them is fiction.

## Amendment — 2026-07-20: rule 5 narrowed to logged-in cookies

A logged-out, deletable session is permitted on the download path; logged-in credentials are not. The reasoning behind rule 5 — a banned account and a crossed anonymity line — applies to accounts, and a session with no account has nothing to ban.

## Amendment — 2026-07-23: per-user cap alongside the global budget

The single global budget of 10/day (rule 2) is **household-wide and funded first-come by schedule order**. Per-user discovery jobs fire at staggered hours, and one heavy-follow user's run could fill the whole allowance before anyone else's ran. Their picks were deferred every day and their feeds went empty while the pipeline looked healthy: discovery ran, the guard cleared candidates, downloads succeeded — all of it for one user. Structurally, a single first-come pool starves whoever runs last, and in a household that can be a kid — the point of the system (brief §1).

**Decision:** the budget becomes **two limits, and the tighter governs each slate run**:

- **Global budget — now 30/day** (`DOWNLOAD_DAILY_BUDGET`). Unchanged in purpose: the volume ceiling for the household's address. It is a property of the address, not of family size, so it stays a single fixed number regardless of how many profiles exist.
- **Per-user budget — 10/day** (`PER_USER_DOWNLOAD_DAILY_BUDGET`). A fairness floor: no one user's automated downloads may exceed this per UTC day, so an early, heavy-follow user cannot drain the pool before later-scheduled users run.

The allowance for a run is `min(globalBudget − globalSpent, perUserBudget − userSpent)` (`automatedDownloadAllowance`), fed to the same slate-first planner. The global cap earns its keep when headcount or the per-user cap changes: adding a profile keeps total exposure pinned rather than drifting up. Share-sheet / on-demand fetches still count toward both tallies and are still never refused.

**Considered and rejected — per-user cap only (drop the global budget).** For a fixed household it is equivalent, and simpler. Rejected because it couples the volume ceiling to headcount, which is exactly the wrong thing to couple it to: one more profile would silently raise exposure, back over the line this whole ADR exists to hold.

## Amendment — 2026-10-09: reframed for publication

The public form of this record was reframed around restraint: rule 4 now states the reason (less traffic, not different traffic) rather than a comparison of network ranges, and household volumes and schedule details were removed. The rules themselves are unchanged. One addition since July: a signature-blind failure-streak alert, so a block that doesn't match the known bot-check signature still reaches a human. It alerts only; pausing stays the circuit breaker's call.
