# yt-dlp exposure is budgeted, slate-bound, and residential

After [[0011-discovery-metadata-via-data-api]] moved metadata reads to the Data API, downloads are the only meaningful yt-dlp traffic Eddy sends from the household IP. The July 2026 incident showed the remaining machinery still loses to a determined block: the flag survived three days, a yt-dlp nightly update, the latest PO-token stack, and a WAN IP change, while the escalating cooldown's expiry-probe loop (one probe every ~12h, each re-tripping and re-arming) at best delayed recovery and at worst kept the flag warm. Meanwhile the DB showed the real demand shape: ~25 downloads/day against a pool of 1,000 `ready` videos of which ~100 have ever been watched — and 65 of the 78 downloads parked by the block were eager fetches of follow uploads nobody had asked to watch.

The decision is a cluster that only makes sense together — **downloads are demand-driven and budgeted, the pipeline surrenders early when blocked, and the traffic stays on the residential IP**:

1. **Slate-bound downloads, follows included.** A follow upload enters the candidate pool on RSS poll, but bytes move only when the daily slate selects the video (or a kid explicitly requests it). This extends [[0009-subscriptions-and-discovery-compose-one-slotted-slate]]'s "follows wait for the slate" from surfacing to *fetching*. Eager pre-fetch of every upload from every followed channel (~22/day) was the dominant volume driver.
2. **Global download budget of 10/day**, priority-ordered: slate-bound videos first, follow-sourced picks second. Back-catalogue seeding is under **full moratorium** — the pool-to-consumption ratio (10:1) says depth is a luxury already banked.
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
- **Throwaway-account cookies as a blocked-state fallback.** Rejected above; also explicitly deferred territory in the brief and it would be load-bearing infrastructure the moment it existed.
- **Keep eager follow downloads, budget only discovery.** The parked-queue autopsy showed follows *are* the volume; budgeting around them is fiction.
