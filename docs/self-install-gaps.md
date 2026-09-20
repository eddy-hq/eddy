# Self-install gaps

What stands between Eddy as it runs in one household and Eddy as something another
self-hosting parent could install. Written alongside the first marketing-site designs
(2026-09-20), which promise several of these. Not a plan and not phased: a list to
triage. Goal is downloads and use, not money.

Ordered by how badly each one blocks a stranger.

## Blocks the pitch itself

1. **The guard is in shadow mode.** The site's central claim is "a local model checks
   it and uncertain ones go to a parent". Phase 6 (guard live) and the parent approval
   path are not shipped. Until they are, the honest pitch is "request and watch without
   the feed", and the site should not go public with the guard copy.
2. **No parent notification channel.** Log-only since ntfy went. "Approve from your lock
   screen" depends on APNs stages 4–5, which depend on the per-household iOS build (see 6).
   A stranger without an Apple developer account has no way to hear about an escalation.
   This may force a second look at ADR-0003 for non-iOS-shell households; flag, don't
   decide here.

## Blocks installation

3. **No installer.** Today's install is: two machines, launchd plists, a systemd unit,
   Redis, Ollama, nginx, Caddy from a separate repo, a hand-written `.env`. The site
   promises `install.sh` and `docker compose`. Needs a single-machine topology as the
   default (worker, Redis and media serving on the same box), with the two-box split as
   the advanced option.
4. **No first-run setup.** Users come from `src/db/seed.ts` and `.env`. Needs an
   `eddy setup` (or a first-run web screen) that creates the household, adds each child
   with a birth year, and prints pairing links.
5. **Household-specific assumptions in the tree.** The domain, the SSH host alias in
   the watchdog, the deploy script's two-host shape, media URL rewriting to one
   hostname. Needs a sweep for anything that assumes this household.
6. **The iOS shell needs a paid Apple developer account per household.** Ad hoc signing
   is right for us and a wall for most others. Realistic path for strangers: PWA plus the
   Shortcut. Worth checking: Android gets a share target free via the PWA manifest
   (Web Share Target), which would make Android the easiest platform rather than an
   unsupported one.
7. **TLS and hostname.** HTTPS is required for the PWA and comes from Caddy with a
   DNS-01 challenge against a domain we own. A stranger has no domain. Tailscale's own
   HTTPS certificates (`*.ts.net`) are the likely answer; untested.

## Blocks trust

8. **No licence.** The repo is public with no licence file, so nobody can legally use
   it. Pick one. The site has `[LICENCE]` placeholders.
9. **No README aimed at a stranger, no screenshots, no demo.** The brief is a spec, not
   an introduction. The site designs use drawn phone mock-ups; real screenshots with
   placeholder content would sell better.
10. **Public-repo hygiene.** Before pointing strangers at it: check history for household
    detail, and decide whether ops docs that describe our network belong in the public tree.

## Blocks staying installed

11. **Download reliability is an ops burden.** Bot detection, cookie jars, nightly
    yt-dlp pins: we absorb this weekly. A stranger will hit it in week one. Needs at
    least a self-updating yt-dlp and a plain-language "downloads are failing, here is
    why" surface.
12. **No update path.** `git pull` plus `npm run deploy`. Needs `eddy update` or image tags.
13. **No backup story on a single box.** Nightly backup currently goes to the second machine.
14. **Hardware honesty.** The guard model wants roughly 16 GB and is only pleasant on
    Apple Silicon or a GPU. Needs a measured minimum and disk-use guidance; the site has
    `[SIZE GUIDANCE]` placeholders.

## Decisions the site forces

- **Where the site lives.** `eddyhq.app` resolves to a tailnet address and serves our
  PWA. A public site on the apex means moving the household PWA to a subdomain (or to a
  `ts.net` name, which item 7 may want anyway). The iOS shell's base URL is already
  config, so that move is cheap.
- **How to describe downloading.** Fetching YouTube video to disk is against YouTube's
  terms. The designs say "the video goes to disk you own" and do not name the tool in
  headline copy. A public domain that markets this is a small but real takedown risk;
  GitHub Pages or similar is more exposed to that than a box we control.
- **Scope of the promise.** The brief describes an adult daily read across media. None
  of that exists. The site sells kids' YouTube only and says so.
