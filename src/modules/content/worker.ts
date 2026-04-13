// Shared job data type used by both the M4 (enqueue) and Ubuntu worker (process).
export interface DownloadJobData {
  requestId: string;
  youtubeId: string;
  url: string;
}
