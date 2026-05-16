import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../config', () => ({
  config: { YTDLP_BIN: '/fake/yt-dlp', VIDEO_OUTPUT_PATH: '/tmp', NODE_ENV: 'test' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { cleanStaleIntermediates, makeUnifiedProgressParser } from './download';

function feedAll(lines: string[]): number[] {
  const emitted: number[] = [];
  const parser = makeUnifiedProgressParser((pct) => emitted.push(pct));
  for (const line of lines) parser.feed(line);
  return emitted;
}

function isMonotonic(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) return false;
  }
  return true;
}

describe('makeUnifiedProgressParser', () => {
  it('maps a single video-stream download to the 5–60 band', () => {
    const lines = [
      '[download] Destination: /tmp/abc.mp4',
      '[download]   0.0% of ~ 100.00MiB at  1.00MiB/s ETA 01:40',
      '[download]  50.0% of ~ 100.00MiB at  1.00MiB/s ETA 00:50',
      '[download] 100.0% of ~ 100.00MiB at  1.00MiB/s ETA 00:00',
    ];
    const emitted = feedAll(lines);

    expect(isMonotonic(emitted)).toBe(true);
    expect(emitted[0]).toBe(5);
    expect(emitted[emitted.length - 1]).toBe(60);
    for (const v of emitted) expect(v).toBeGreaterThanOrEqual(5);
    for (const v of emitted) expect(v).toBeLessThanOrEqual(60);
  });

  it('chains video + audio streams across the 5–85 band without going backwards', () => {
    const lines = [
      '[download] Destination: /tmp/abc.f137.mp4',
      '[download]   0.0% of ~ 200.00MiB',
      '[download]  50.0% of ~ 200.00MiB',
      '[download] 100.0% of ~ 200.00MiB',
      '[download] Destination: /tmp/abc.f140.m4a',
      '[download]   0.0% of ~  10.00MiB',
      '[download]  50.0% of ~  10.00MiB',
      '[download] 100.0% of ~  10.00MiB',
    ];
    const emitted = feedAll(lines);

    expect(isMonotonic(emitted)).toBe(true);
    expect(emitted[0]).toBe(5);
    expect(emitted[emitted.length - 1]).toBe(85);
    // mid-video should be inside the video band
    expect(emitted).toContain(32);
    // post-bridge: at least one tick at 60 (start of audio band)
    expect(emitted).toContain(60);
  });

  it('jumps to 85 on merge and to 99 on "Deleting original file"', () => {
    const lines = [
      '[download] Destination: /tmp/abc.f137.mp4',
      '[download] 100.0% of ~ 200.00MiB',
      '[download] Destination: /tmp/abc.f140.m4a',
      '[download] 100.0% of ~  10.00MiB',
      '[Merger] Merging formats into "/tmp/abc.mp4"',
      'Deleting original file /tmp/abc.f137.mp4 (pass -k to keep)',
      'Deleting original file /tmp/abc.f140.m4a (pass -k to keep)',
    ];
    const emitted = feedAll(lines);

    expect(isMonotonic(emitted)).toBe(true);
    expect(emitted).toContain(85);
    expect(emitted[emitted.length - 1]).toBe(99);
  });

  it('caps emissions at 99 — never emits 100 from yt-dlp output alone', () => {
    const lines = [
      '[download] Destination: /tmp/abc.mp4',
      '[download] 100.0% of ~ 100.00MiB',
      '[Merger] Merging formats into "/tmp/abc.mp4"',
      'Deleting original file /tmp/abc.f137.mp4',
    ];
    const emitted = feedAll(lines);

    for (const v of emitted) expect(v).toBeLessThanOrEqual(99);
  });

  it('is monotonic when stream 2 progress arrives interleaved with stragglers', () => {
    // Realistic-ish: yt-dlp can emit "[download] 100% of ..." for stream 1
    // right before the next "Destination:" line. Make sure clamping works.
    const lines = [
      '[download] Destination: /tmp/abc.f137.mp4',
      '[download]  99.5% of ~ 200.00MiB',
      '[download] 100.0% of ~ 200.00MiB',
      '[download] Destination: /tmp/abc.f140.m4a',
      '[download]   0.0% of ~  10.00MiB',
    ];
    const emitted = feedAll(lines);

    expect(isMonotonic(emitted)).toBe(true);
  });

  it('strips trailing carriage returns from yt-dlp output', () => {
    const lines = [
      '[download] Destination: /tmp/abc.mp4\r',
      '[download]  50.0% of ~ 100.00MiB\r',
    ];
    const emitted = feedAll(lines);

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[emitted.length - 1]).toBeGreaterThanOrEqual(30);
  });

  it('ignores non-progress noise lines', () => {
    const lines = [
      '[youtube] Extracting URL: ...',
      '[info] abc: Downloading 1 format(s): 137+140',
      '[download] Destination: /tmp/abc.mp4',
      '[download] 100.0% of ~ 100.00MiB',
    ];
    const emitted = feedAll(lines);

    expect(isMonotonic(emitted)).toBe(true);
    expect(emitted[emitted.length - 1]).toBe(60);
  });
});

describe('cleanStaleIntermediates', () => {
  function setup(youtubeId: string, files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eddy-clean-'));
    for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
    cleanStaleIntermediates(dir, youtubeId);
    return dir;
  }

  it('removes per-format intermediates and subtitle files', () => {
    const id = 'vidABC';
    const dir = setup(id, [`${id}.f137.mp4`, `${id}.f140.m4a`, `${id}.en.vtt`]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('preserves the final merged mp4 (idempotency signal)', () => {
    const id = 'vidABC';
    const dir = setup(id, [`${id}.mp4`, `${id}.f137.mp4`]);
    expect(fs.readdirSync(dir)).toEqual([`${id}.mp4`]);
  });

  it('does not touch files for other youtubeIds', () => {
    const id = 'vidABC';
    const dir = setup(id, [`${id}.f137.mp4`, 'vidXYZ.f137.mp4', 'vidXYZ.mp4']);
    expect(fs.readdirSync(dir).sort()).toEqual(['vidXYZ.f137.mp4', 'vidXYZ.mp4']);
  });

  it('is a no-op when the directory does not exist', () => {
    expect(() => cleanStaleIntermediates('/nonexistent/path/xyz', 'whatever')).not.toThrow();
  });
});
