import { describe, it, expect } from 'vitest';
import {
  isRemovableParkedState,
  deriveRequestId,
  parseWorkerProbe,
  bothProbesClear,
} from './pipeline-pause-lib';

describe('isRemovableParkedState', () => {
  it('removes queued-but-not-running states', () => {
    expect(isRemovableParkedState('delayed')).toBe(true);
    expect(isRemovableParkedState('waiting')).toBe(true);
    expect(isRemovableParkedState('paused')).toBe(true);
  });

  it('never removes an active (mid-download) job', () => {
    expect(isRemovableParkedState('active')).toBe(false);
  });

  it('leaves terminal / unknown states alone', () => {
    expect(isRemovableParkedState('completed')).toBe(false);
    expect(isRemovableParkedState('failed')).toBe(false);
    expect(isRemovableParkedState('unknown')).toBe(false);
  });
});

describe('deriveRequestId', () => {
  it('returns a bare download jobId unchanged', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(deriveRequestId(id)).toBe(id);
  });

  it('strips the restore- prefix', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(deriveRequestId(`restore-${id}`)).toBe(id);
  });

  it('only strips a leading prefix, not a mid-string match', () => {
    expect(deriveRequestId('abc-restore-def')).toBe('abc-restore-def');
  });
});

describe('parseWorkerProbe', () => {
  it('is clear on exit 0 with a positive duration', () => {
    expect(parseWorkerProbe(0, JSON.stringify({ id: 'x', duration: 19 }))).toBe(true);
  });

  it('takes the first non-empty JSON line and tolerates trailing whitespace', () => {
    const out = `\n  ${JSON.stringify({ duration: 19 })}  \n`;
    expect(parseWorkerProbe(0, out)).toBe(true);
  });

  it('is blocked on a non-zero exit even if stdout looks valid', () => {
    expect(parseWorkerProbe(1, JSON.stringify({ duration: 19 }))).toBe(false);
  });

  it('is blocked when ssh could not run (null exit)', () => {
    expect(parseWorkerProbe(null, '')).toBe(false);
  });

  it('is blocked on empty output', () => {
    expect(parseWorkerProbe(0, '')).toBe(false);
    expect(parseWorkerProbe(0, '   \n  \n')).toBe(false);
  });

  it('is blocked on unparseable output', () => {
    expect(parseWorkerProbe(0, 'ERROR: Sign in to confirm you are not a bot')).toBe(false);
  });

  it('is blocked when duration is missing, zero, or non-numeric', () => {
    expect(parseWorkerProbe(0, JSON.stringify({ id: 'x' }))).toBe(false);
    expect(parseWorkerProbe(0, JSON.stringify({ duration: 0 }))).toBe(false);
    expect(parseWorkerProbe(0, JSON.stringify({ duration: '19' }))).toBe(false);
  });
});

describe('bothProbesClear', () => {
  it('resumes only when both paths are clear', () => {
    expect(bothProbesClear(true, true)).toBe(true);
  });

  it('stays paused if either path is blocked', () => {
    expect(bothProbesClear(true, false)).toBe(false);
    expect(bothProbesClear(false, true)).toBe(false);
    expect(bothProbesClear(false, false)).toBe(false);
  });
});
