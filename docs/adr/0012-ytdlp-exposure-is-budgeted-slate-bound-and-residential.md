# yt-dlp exposure is budgeted, slate-bound, and residential

After [[0011-discovery-metadata-via-data-api]] moved metadata reads to the Data API, downloads are the only meaningful yt-dlp traffic Eddy sends from the household IP. The July 2026 incident showed the remaining machinery still loses to a determined block: the flag survived three days, a yt-dlp nightly update, the latest PO-token stack, and a WAN IP change, while the escalating cooldown's expiry-probe loop (one probe every ~12h, each re-tripping and re-arming) at best delayed recovery and at worst kept the flag warm. Meanwhile the DB showed the real demand shape: ~25 downloads/day against a pool of 1,000 `ready` videos of which ~100 have ever been watched — and 65 of the 78 downloads parked by the block were eager fetches of follow uploads nobody had asked to watch.

The decision is a cluster that only makes sense together — **downloads are demand-driven and budgeted, the pipeline surrenders early when blocked, and the traffic stays on the residential IP**:

1. **Slate-bound downloads, follows included.** A follow upload enters the candidate pool on RSS poll, but bytes move only when the daily slate selects the video (or a kid explicitly requests it). This extends [[0009-subscriptions-and-discovery-compose-one-slotted-slate]]'s "follows wait for the slate" from surfacing to *fetching*. Eager pre-fetch of every upload from every followed channel (~22/day) was the dominant volume driver.
2. **Global download budget of 10/day**, priority-ordered: slate-bound videos first, follow-sourced picks second. Back-catalogue seeding is under **full moratorium** — the pool-to-consumption ratio (10:1) says depth is a luxury already banked. *(Amended 2026-07-23: the global budget is 30/day and is now paired with a per-user cap of 10/day — see the amendment below.)*
3. **Circuit breaker over endless cooldown.** After 3 consecutive bot-detection re-trips, both yt-dlp-touching queues auto-pause (the `pipeline-pause` lever) and Steve gets one ntfy alert. Resume is always manual, via a dual-path probe (M4 anonymous path *and* the worker's mweb+POT path — a clear anonymous probe does not prove the download path is clear). Dark-until-manual is chosen over autonomous backoff because past a day of consecutive blocks every automated probe has negative expected value: it can only refresh the flag.
4. **Egress stays residential.** No VPN, no proxy, no VPS tunnel. Datacenter and VPN ranges are more aggressively flagged than residential IPs; residential-proxy services are ethically murky and a running cost; and the block's blast radius is Eddy alone — the family's signed-in browsers and apps are unaffected. Revisit only if outages become weekly rather than quarterly.
5. **No cookies, ever, including as break-glass.** A throwaway account under bot suspicion gets banned rather than rate-limited, converting a self-healing outage into a dead credential with a maintenance burden — and cookies on the kids' download path cross the anonymity line the brief draws (§256). When a block hits despite the above, the pipeline is simply dark until the flag decays and the family lives off the pool.

## Consequences

- A kid tapping into a followed channel's brand-new upload before the slate picks it hits "not downloaded yet" and waits minutes for an on-demand fetch, instead of today's instant play. This is the accepted cost of making the budget arithmetically honest.
- The candidate pool grows slower; a newly declared interest takes an extra day or two to gain depth. The 1,000-video pool absorbs this.
- Recovery from a block requires Steve. If he is away for a week, the pipeline stays dark even if the flag cleared on day two — chosen deliberately over autonomous probing.
- On resume after a pause, parked download jobs are cleared rather than drained: BullMQ jobs removed, their request rows moved to a non-destructive state so slate composition can re-select them under the budget. No backlog burst into a freshly-cleared IP.

## Considered and rejected

- **VPN / residential proxy / VPS egress for yt-dlp.** Trades occasional residential blocks for constant datacenter-range flagging, adds cost and an infra dependency, and protects nothing the block actually threatens (family YouTube use is unaffected).
- **Autonomous exponential probe backoff (24h → 48h → 96h).** Stays hands-off but keeps spending probes against a flag whose TTL is unknown; the probes themselves are the suspected flag-refresher. Manual resume with a good alert is cheaper and safer.
- **Throwaway-*account* cookies as a blocked-state fallback.** A *logged-in* account under bot suspicion gets banned rather than rate-limited, and account cookies on the kids' download path cross the anonymity line the brief draws (§256). Still rejected. (This is distinct from the anonymous guest-visitor jar adopted in the 2026-07-20 amendment below, which involves no login and nothing to ban.)
- **Keep eager follow downloads, budget only discovery.** The parked-queue autopsy showed follows *are* the volume; budgeting around them is fiction.

## Amendment — 2026-07-20: guest-visitor cookie jar narrows rule 5

Rule 5 ("No cookies, ever, including as break-glass") was written about **account** cookies — a logged-in credential that gets *banned* under bot suspicion, converting a self-healing outage into a dead credential with a maintenance burden, and that crosses the anonymity line the brief draws (§256). That reasoning is sound and **unchanged**: logged-in / account cookies remain forbidden on every yt-dlp path, for exactly those reasons.

It does not, however, cover an **anonymous guest-visitor cookie jar** — an aged, *never-logged-in* identity minted by a single yt-dlp touch of one video, deletable at will. YouTube appears to score fresh anonymous sessions per IP (yt-dlp issues #14899 / #15865), and an aged never-logged-in guest cookiefile passes gates that fresh-per-invocation sessions fail (#15583). There is no account, so there is nothing to ban: if the identity is flagged, you delete the jar (behaviour reverts to fresh-session-per-run) and mint a new one after the block clears.

**Decision:** rule 5 is narrowed. An anonymous guest-visitor jar is **adopted** for the worker download path (and the worker resume probe, so the probe exercises the same identity downloads use), gated behind `YTDLP_GUEST_COOKIES` (empty default = prior fresh-session behaviour). Logged-in / account cookies stay forbidden. The jar is worker-side, outside the repo, and never committed. See docs/ops.md for minting, ageing, and rotation.

## Amendment — 2026-07-23: per-user cap alongside the global budget

The single global budget of 10/day (rule 2) is **fleet-wide and funded first-come by cron order**. Per-user discovery jobs fire at staggered hours (parent h6, Boy2 h10, Boy1 h14), and the parent's follow list alone fills 10 downloads every morning — so from the day this budget landed, the parent's 06:00 run consumed the entire day's allowance before either kid's run, and both kids' surfaced picks were deferred (reverted to `scored`, `surfaced_date=NULL`) every day. Their app feeds (which show only `status='surfaced'` for today) went empty while the pipeline looked healthy: discovery ran, the guard cleared candidates, downloads succeeded — all of it for the parent. Structurally, a single first-come pool starves whoever is last in the cron order, and that is the kids — the point of the system (brief §1).

**Decision:** the budget becomes **two limits, and the tighter governs each slate run**:

- **Global (fleet-wide) budget — now 30/day** (`DOWNLOAD_DAILY_BUDGET`). Unchanged in purpose: the bot-detection volume ceiling. It is a property of the household IP, not of family size, so it stays a single fixed number regardless of how many profiles exist.
- **Per-user budget — 10/day** (`PER_USER_DOWNLOAD_DAILY_BUDGET`). A fairness floor: no one user's automated downloads may exceed this per UTC day, so an early, heavy-follow user cannot drain the pool before later-scheduled users run.

For today's three users, 3 × 10 = 30, so each gets a guaranteed 10 and the global ceiling never binds first. The global cap earns its keep when headcount or the per-user cap changes — e.g. adding the (gated) fourth profile keeps total exposure pinned at 30 rather than drifting to 40. The allowance for a run is `min(globalBudget − globalSpent, perUserBudget − userSpent)` (`automatedDownloadAllowance`), fed to the same slate-first planner. Share-sheet / on-demand fetches still count toward both tallies and are still never refused.

**Considered and rejected — per-user cap only (drop the global budget).** For a fixed 3-person household it is equivalent (3 × 10 = 30), and simpler. Rejected because it couples the bot-detection ceiling to headcount, which is exactly the wrong thing to couple it to: the fourth profile would silently raise exposure to 40/day, back over the line this whole ADR exists to hold.
