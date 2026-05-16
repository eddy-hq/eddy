// Shared job data type used by both the M4 (enqueue) and Ubuntu worker (process).
//
// `mode` is the seam between a fresh download (default — undefined / 'download')
// and a restore from `file_state = 'recycled'` (issue #116). When set to
// `'restore'`, the worker skips guard scoring (the original verdict already
// approved this video) and posts the completion callback to the restore
// endpoint, which preserves `status` and clears `recycled_at`. Optional on the
// wire so an older worker reading a job enqueued by a newer M4 still works —
// an absent value is treated as a normal download.
export interface DownloadJobData {
  requestId: string;
  youtubeId: string;
  url: string;
  mode?: 'download' | 'restore';
}
