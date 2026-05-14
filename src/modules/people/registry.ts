// Synchronous person-resolver surface. Owns the helpers that callers in the
// request lifecycle (notably `requests/state.ts`) need without dragging the
// rest of the people barrel (RSS poller, HTTP router, yt-dlp + ollama-backed
// interest inference) into their module graph.
//
// Deep-imported by `requests/state.ts` only; siblings continue to go through
// the `../people` barrel. This is the one planned exception to the module-
// boundary rule, taken to break the runtime cycle between requests and people.
export { ensurePersonForChannel } from './ensurePerson';
export { applyChannelInfoToPerson } from './applyChannelInfo';
