import { getNotifications } from '../notifications';
import { downloadQueue, deleteQueue, redis } from '../../queue';
// Deep-imports `../people/registry` rather than the `../people` barrel — the
// barrel imports from this module (the `getRequestsState` accessor below), so
// going through it would create a runtime cycle. Pulling just the synchronous
// person helpers from the leaf `registry` module keeps the graph acyclic.
// This is a planned exception to the module-boundary rule (see issue #87).
import { ensurePersonForChannel, applyChannelInfoToPerson } from '../people/registry';
import { createRequestsState, type Ports, type RequestsState } from './state';

// ─── Default port bindings ───────────────────────────────────────────────────
//
// Production wiring for `createRequestsState`. Imports the upstream modules
// statically here (rather than in state.ts) so the state machine itself stays
// free of side-effect-heavy dependencies (BullMQ, Redis, notifications, yt-dlp). Tests
// that exercise `getRequestsState().apply(...)` against `vi.mock`'d upstream
// modules see those mocks through these closures.
function defaultPorts(): Ports {
  return {
    notifyVideoReady: (userId, requestId, title) =>
      getNotifications().notify({ kind: 'video_ready', requestId, title }, userId),
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
// calling `getRequestsState()`, which builds Ports from the (now-mocked)
// module-level imports.

let _defaultState: RequestsState | null = null;

function defaultState(): RequestsState {
  if (_defaultState === null) {
    _defaultState = createRequestsState({ ports: defaultPorts() });
  }
  return _defaultState;
}

// Public accessor — call sites do `getRequestsState().apply({ kind: ..., ... })`.
// Routes through whatever state was registered at boot (or the lazy default
// in tests). Kept as a function rather than a re-exported binding so the
// production-wired state from `registerDefaultRequestsState` is always read
// fresh, not captured at import time.
export function getRequestsState(): RequestsState {
  return defaultState();
}

// Production-wiring seam: server.ts and the worker boot call this once at
// startup with a state constructed from the real queue/notifications/people
// handlers. `getRequestsState()` routes through whatever was registered, so
// call sites keep the same accessor but the dependencies are now explicit
// and replaceable.
//
// This is idempotent within a process — the second call wins, used by tests
// that want to override the default with explicit fakes. The first registered
// state captures whichever ports were passed in; subsequent `getRequestsState`
// calls see the updated wiring.
export function registerDefaultRequestsState(state: RequestsState): void {
  _defaultState = state;
}
