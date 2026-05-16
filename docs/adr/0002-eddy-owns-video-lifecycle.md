# Eddy owns the video lifecycle; Plex and nginx are read-only consumers

The obvious shape for "self-host YouTube to a Plex library" is Tube Archivist — it owns the queue, the storage layout, the retry behaviour, and the metadata. Eddy instead shells out to yt-dlp directly from the Ubuntu worker, writes into `$VIDEO_OUTPUT_PATH` under its own naming scheme (`{youtube_id}.mp4`), and treats Plex and nginx as read-only consumers of that directory. The SQLite row is the source of truth for whether a file exists, is **Live**, **Recycled**, or **Gone**; the filesystem follows.

The lifecycle ownership is the load-bearing part. The **Recycler** needs to delete files on its own schedule, immune to anything Plex or a download tool thinks. **Saved** items being immune to recycling is enforced at the storage layer because Eddy controls deletion — a third-party tool would either fight that or require working around its retention model. Adding a new consumer later (a native iOS app, a TV interface) is a read-only directory mount; nothing in the lifecycle changes.

## Consequences

- Eddy reimplements queueing, retry, and channel-watch that Tube Archivist would have provided — that's real cost paid at build time.
- Plex must never be the surface that triggers re-downloads or deletes; if it ever needs to, this ADR has been violated.
- yt-dlp behaviour changes (extractor breakage, format flags) land in Eddy directly — keep the invocation thin and pinned, and own the upgrade path.
