# Discovery metadata moves from yt-dlp scraping to the YouTube Data API

Eddy reads two kinds of thing from YouTube: **metadata** (search results, a channel's upload list, a video's duration, a channel bio/avatar) and **bytes** (the actual video file). Until now both went through yt-dlp on the M4 — every discovery run scraped search pages, walked playlists with `--flat-playlist`, and probed durations, on top of the worker's authenticated downloads. That metadata fan-out is the dominant share of the fleet's ~450 YouTube requests/day, and volume from one residential IP is what trips YouTube's IP-wide bot-detection ("Sign in to confirm you're not a bot"), which then blocks downloads too — see [[../adr/0001-ubuntu-moves-bytes-m4-thinks]] for the box split and #185 for the throttling work that preceded this.

The YouTube Data API v3 returns exactly the metadata discovery needs — `search.list` (relevance-ordered ids), `playlistItems.list` (a channel's uploads), `videos.list` (durations, view counts, real publish dates, live status), `channels.list` (bio + avatar) — over an authenticated, rate-budgeted channel that does **not** count against the scraping footprint. It reads public data only, with a plain API key (no OAuth, no billing account); the free tier is 10,000 units/day, resetting at midnight Pacific.

The decision: **discovery metadata reads move to the Data API; yt-dlp is retained for downloads only.** The switch is behind a `DISCOVERY_SOURCE` flag (`ytdlp` default | `api`) so the change is reversible per-deploy, with a single dispatch seam (`src/discovery-metadata.ts`) selecting the source — every discovery call site imports the four functions from the seam, never from `ytdlp`/`youtubeapi` directly. The adapter (`src/youtubeapi.ts`) returns the *same* shapes as the yt-dlp adapter, so nothing downstream changes.

## Quota envelope

The unit costs are asymmetric: `search.list` is 100 units, everything else is 1. The current fleet's daily shape:

- Interest search: ~3 users × ~10 terms × (100 + 1) ≈ **3,030 units**
- Back-catalogue: `playlistItems.list` pages (1 unit each) + one batched `videos.list` per channel ≈ a few hundred units
- Per-person duration probes and channel-info refreshes (TTL-gated, #185): ~1 unit each, low hundreds combined

Total lands around **3.9k of the 10k/day free tier** — comfortable headroom, dominated by the 100-unit search calls. `getQuotaUsage()` exposes a running local tally (reset on the UTC day, a few hours' skew from the Pacific reset accepted) and logs once when the day crosses 80%.

## Consequences

- **On quota exhaustion, discovery skips and warns — it does not fall back to yt-dlp scraping.** Falling back would defeat the purpose: the whole point is to keep the request footprint off the residential IP. A `quotaExceeded`-flagged error breaks out of the interest-search and back-catalogue loops for the rest of the run (`src/modules/discovery/intake.ts`), the same shape as the bot-detection stand-down but log-only (no ntfy), mirroring [[../adr/0001-ubuntu-moves-bytes-m4-thinks]]'s cooldown precedent in `botdetect.ts`.
- **Downloads stay on yt-dlp, unconditionally.** The seam routes metadata only; the worker's authenticated PO-token download path is untouched. Eddy still owns the video files ([[../adr/0002-eddy-owns-video-lifecycle]]).
- **The privacy boundary is unchanged.** Search terms already leave the M4 to YouTube under yt-dlp; routing them through the Data API instead changes the *transport*, not *what leaves*. No kid consumption data is added to any request — the API calls carry a search string or a video/channel id, nothing user-identifying ([[../adr/0004-kids-consumption-never-leaves-m4]]).
- **A new secret.** `YOUTUBE_API_KEY` is required only when `DISCOVERY_SOURCE=api` (enforced by a zod `superRefine`). It is a key, not a credential for a user account; it grants read-only access to public data and nothing in Eddy.
- **Reversible.** Setting `DISCOVERY_SOURCE=ytdlp` (or unsetting it) restores the pre-existing scraping path with no code change — the yt-dlp adapter is retained, not deleted.

## Considered and rejected

- **Keep everything on yt-dlp, just throttle harder (#185 alone).** Already done — per-user scheduling, search-depth halving, inter-search jitter, TTL-gated channel-info. It reduced the footprint but didn't remove the structural problem: metadata volume and download volume share one IP, so a metadata-triggered block still kills downloads. The Data API removes metadata from that IP entirely.
- **Move downloads to the Data API too.** Not possible — the Data API serves metadata, not media bytes. Downloads must stay on yt-dlp.
- **Fall back to yt-dlp on quota exhaustion.** Rejected above: it reintroduces exactly the scraping load the change exists to eliminate, and the 10k tier has ~2.5× headroom over current use, so exhaustion is a misconfiguration signal worth surfacing (a warn log), not a routine case worth papering over.
