import { sendVideoReady } from '../notifications';
import { downloadQueue, deleteQueue, redis } from '../../queue';
// Deep-imports `../people/registry` rather than the `../people` barrel — the
// barrel imports `createFromChannelPoll` from this module's shim re-exports,
// so going through it would create a runtime cycle. Pulling just the
// synchronous person helpers from the leaf `registry` module keeps the
// graph acyclic. This is a planned exception to the module-boundary rule
// (see issue #87).
import { ensurePersonForChannel, applyChannelInfoToPerson } from '../people/registry';
import {
  createRequestsState,
  type Ports,
  type RequestsState,
  type TransitionResult,
  type DownloadedFields,
  type CreateFromShareSheetInput,
  type CreateFromChannelPollInput,
  type CreateFromCandidateInput,
} from './state';

// ─── Default port bindings ───────────────────────────────────────────────────
//
// Production wiring for `createRequestsState`. Imports the upstream modules
// statically here (rather than in state.ts) so the state machine itself stays
// free of side-effect-heavy dependencies (BullMQ, Redis, ntfy, yt-dlp). Tests
// that exercise the per-verb shim exports below still see vi.mock'd upstream
// modules through these closures.
function defaultPorts(): Ports {
  return {
    notifyVideoReady: (userId, requestId, title) => sendVideoReady(userId, requestId, title),
    enqueueDownload: (jobData, opts) => downloadQueue.add('download', jobData, opts),
    enqueueDelete: (jobData, opts) => deleteQueue.add('delete', jobData, opts),
    cancelDownloadJob: async (requestId) => {
      const job = await downloadQueue.getJob(requestId);
      await job?.remove();
    },
    redisDel: (key) => redis.del(key),
    ensurePerson: (channelId, channelName) => {
      const { personId, created } = ensurePersonForChannel(channelId, channelName);
      return { personId, created };
    },
    applyChannelInfo: (personId, channelId) => applyChannelInfoToPerson(personId, channelId),
  };
}

// ─── Module-level default state ──────────────────────────────────────────────
//
// Constructed lazily on first access so vi.mock() of the upstream modules
// (queue, notifications, people/registry, logger) takes effect before any
// Port closure captures a stale binding. Test files set up mocks before
// importing the per-verb shims; the shims read defaultState() which builds
// Ports from the (now-mocked) module-level imports.

let _defaultState: RequestsState | null = null;
function defaultState(): RequestsState {
  if (_defaultState === null) {
    _defaultState = createRequestsState({ ports: defaultPorts() });
  }
  return _defaultState;
}

// Production-wiring seam: server.ts and the worker boot call this once at
// startup with a state constructed from the real queue/notifications/people
// handlers. The per-verb shim exports below route through whatever was
// registered, so call sites keep their existing import names but the
// dependencies are now explicit and replaceable.
//
// This is idempotent within a process — the second call wins, used by tests
// that want to override the default with explicit fakes. The first registered
// state captures whichever ports were passed in; subsequent module-level
// shim calls see the updated wiring.
export function registerDefaultRequestsState(state: RequestsState): void {
  _defaultState = state;
}

// Per-verb shim exports — preserve the pre-refactor API exactly so existing
// call sites compile unchanged. The slice after #84 (#85) deletes these
// adapters and moves all call sites onto `apply` directly.
export function markWatched(id: string): TransitionResult {
  return defaultState().markWatched(id);
}
export function markDismissed(id: string): TransitionResult {
  return defaultState().markDismissed(id);
}
export function markSoftDeleted(id: string): TransitionResult {
  return defaultState().markSoftDeleted(id);
}
export function markDownloaded(id: string, fields: DownloadedFields): TransitionResult {
  return defaultState().markDownloaded(id, fields);
}
export function markRejected(id: string, reason: string): TransitionResult {
  return defaultState().markRejected(id, reason);
}
export function markGuardBlocked(id: string, reason: string): TransitionResult {
  return defaultState().markGuardBlocked(id, reason);
}
export function markCancelled(id: string): TransitionResult {
  return defaultState().markCancelled(id);
}
export function markFailed(id: string): TransitionResult {
  return defaultState().markFailed(id);
}
export function retry(id: string): Promise<TransitionResult> {
  return defaultState().retry(id);
}
export function createFromShareSheet(
  input: CreateFromShareSheetInput,
): Promise<{ requestId: string }> {
  return defaultState().createFromShareSheet(input);
}
export function createFromChannelPoll(
  input: CreateFromChannelPollInput,
): Promise<{ requestId: string }> {
  return defaultState().createFromChannelPoll(input);
}
export function createFromCandidate(
  input: CreateFromCandidateInput,
): Promise<{ requestId: string }> {
  return defaultState().createFromCandidate(input);
}
