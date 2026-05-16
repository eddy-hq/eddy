// In-flight restore tracker — Zustand global so the "restoring" overlay on a
// recycled card persists across page navigations (a kid taps restore on Feed,
// switches to the Timeline tab, the same card should still read as restoring
// until the worker callback flips file_state back to 'live').
//
// Entries are removed by `useRestoreRequest` once the next refetch reports
// the row as `live`, or by the safety-cap timeout in the same hook if the
// worker never reports back — see useRestoreRequest for the cap rationale.

import { create } from 'zustand';

export interface RestoreEntry {
  startedAt: number;   // epoch ms — used for the safety-cap timeout
  errored: boolean;    // true after a non-202 response, surfaces inline error
  errorMsg: string | null;
}

interface RestoreState {
  entries: Record<string, RestoreEntry>;
  start: (requestId: string) => void;
  finish: (requestId: string) => void;
  fail: (requestId: string, message: string) => void;
  clearError: (requestId: string) => void;
}

export const useRestoreStore = create<RestoreState>((set) => ({
  entries: {},
  start: (requestId) => set((s) => ({
    entries: { ...s.entries, [requestId]: { startedAt: Date.now(), errored: false, errorMsg: null } },
  })),
  finish: (requestId) => set((s) => {
    if (!(requestId in s.entries)) return s;
    const next = { ...s.entries };
    delete next[requestId];
    return { entries: next };
  }),
  fail: (requestId, message) => set((s) => ({
    entries: { ...s.entries, [requestId]: { startedAt: Date.now(), errored: true, errorMsg: message } },
  })),
  clearError: (requestId) => set((s) => {
    if (!(requestId in s.entries)) return s;
    const entry = s.entries[requestId];
    if (!entry || !entry.errored) return s;
    const next = { ...s.entries };
    delete next[requestId];
    return { entries: next };
  }),
}));
