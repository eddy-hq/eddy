import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockConfig = vi.hoisted(() => ({
  THUMB_OUTPUT_PATH: '',
  NGINX_THUMB_BASE_URL: 'http://nginx.test/thumbs' as string | undefined,
  M4_INTERNAL_URL: 'http://m4.test' as string | undefined,
}));

vi.mock('../config', () => ({ config: mockConfig }));

vi.mock('../logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: vi.fn(() => log) } };
});

vi.mock('../signed-channel', () => ({ postSigned: vi.fn() }));

// ffmpeg stand-in: writes a small file whose content names the frame, so the
// mocked Gemma endpoints can tell frames apart. promisify() calls this with a
// trailing node-style callback.
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], cb: (err: Error | null, out?: unknown) => void) => {
    const out = args[args.length - 1]!;
    const ssIdx = args.indexOf('-ss');
    const content = ssIdx >= 0 ? `frame-${args[ssIdx + 1]}` : 'placeholder';
    fs.writeFileSync(out, content);
    cb(null, { stdout: '', stderr: '' });
  }),
}));

import { postSigned } from '../signed-channel';
import { generateThumbnail, MAX_SAFETY_CHECKS, PLACEHOLDER_FILENAME } from './thumb';

const YT_ID = 'abcdefghijk';
const DURATION = 100; // frames at 30s, 50s, 70s

type Scores = { violence: number; frightening: number; sexual: number };
const SAFE: Scores = { violence: 0, frightening: 0, sexual: 0 };

interface Scenario {
  creatorStyle: 'editorial' | 'slop';
  autoStyles: Record<string, 'editorial' | 'slop'>;
  // Keyed by YT variant (e.g. 'maxresdefault', 'maxres1') or frame content
  // (e.g. 'frame-30'). Missing key → safe.
  safety: Record<string, Scores | 'error' | 'malformed'>;
  composition: Record<string, number>;
}

let scenario: Scenario;
let calls: Array<{ path: string; key?: string }>;

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

function verdictFor(scores: Scores): unknown {
  const dim = (score: number) => ({ score, reason: 'r' });
  return {
    version: 'thumb-safety-v1',
    pass: scores.violence <= 1 && scores.frightening <= 1 && scores.sexual <= 1,
    scores: { violence: dim(scores.violence), frightening: dim(scores.frightening), sexual: dim(scores.sexual) },
  };
}

function decode(b64: string): string {
  return Buffer.from(b64, 'base64').toString();
}

function safetyCalls(): string[] {
  return calls.filter((c) => c.path === '/internal/thumb/safety').map((c) => c.key!);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-test-'));
  mockConfig.THUMB_OUTPUT_PATH = tmpDir;
  mockConfig.NGINX_THUMB_BASE_URL = 'http://nginx.test/thumbs';
  mockConfig.M4_INTERNAL_URL = 'http://m4.test';
  calls = [];
  scenario = {
    creatorStyle: 'slop',
    autoStyles: {},
    safety: {},
    composition: { 'frame-30': 5, 'frame-50': 6, 'frame-70': 4 },
  };

  // Every preferred YT variant exists (HEAD returns a real-sized image).
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    headers: new Headers({ 'content-length': '50000' }),
  })));

  vi.mocked(postSigned).mockReset();
  vi.mocked(postSigned).mockImplementation(async (p: string, payload: unknown) => {
    const body = payload as Record<string, string>;
    switch (p) {
      case '/internal/thumb/classify':
        calls.push({ path: p });
        return jsonResponse({ style: scenario.creatorStyle });
      case '/internal/thumb/classify-variant':
        calls.push({ path: p, key: body['variant'] });
        return jsonResponse({ style: scenario.autoStyles[body['variant']!] ?? 'slop' });
      case '/internal/thumb/score-frame': {
        const key = decode(body['image']!);
        calls.push({ path: p, key });
        return jsonResponse({ raw: JSON.stringify({ score: scenario.composition[key] ?? 0, reason: 'r' }) });
      }
      case '/internal/thumb/safety': {
        const key = body['image'] ? decode(body['image']) : body['variant']!;
        calls.push({ path: p, key });
        const s = scenario.safety[key] ?? SAFE;
        if (s === 'error') throw new Error('M4 returned 502');
        if (s === 'malformed') return jsonResponse({ pass: true });
        return jsonResponse(verdictFor(s));
      }
      default:
        throw new Error(`unexpected path ${p}`);
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PLACEHOLDER_URL = `http://nginx.test/thumbs/${PLACEHOLDER_FILENAME}`;
const localUrl = expect.stringMatching(new RegExp(`^http://nginx\\.test/thumbs/${YT_ID}\\.webp\\?v=\\d+$`));

function localThumbContent(): string {
  return fs.readFileSync(path.join(tmpDir, `${YT_ID}.webp`)).toString();
}

describe('generateThumbnail safety floor', () => {
  it('keeps an editorial creator thumbnail that passes the floor', async () => {
    scenario.creatorStyle = 'editorial';
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toBe(`https://i.ytimg.com/vi/${YT_ID}/maxresdefault.jpg`);
    expect(safetyCalls()).toEqual(['maxresdefault']);
  });

  it('safety-checks the variant actually served when maxres is missing', async () => {
    scenario.creatorStyle = 'editorial';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: new Headers() })));
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toBe(`https://i.ytimg.com/vi/${YT_ID}/hqdefault.jpg`);
    expect(safetyCalls()).toEqual(['hqdefault']);
  });

  it('falls through to frames when an editorial creator thumbnail fails the floor', async () => {
    scenario.creatorStyle = 'editorial';
    scenario.safety['maxresdefault'] = { violence: 0, frightening: 2, sexual: 0 };
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toEqual(localUrl);
    expect(url).not.toContain('i.ytimg.com');
    // Best-composed frame (50s, score 6) checked and chosen.
    expect(safetyCalls()).toEqual(['maxresdefault', 'frame-50']);
    expect(localThumbContent()).toBe('frame-50');
  });

  it('uses an editorial auto-frame only after it passes the floor', async () => {
    scenario.autoStyles = { hq1: 'editorial', hq2: 'editorial' };
    scenario.safety['maxres1'] = { violence: 2, frightening: 0, sexual: 0 };
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toBe(`https://i.ytimg.com/vi/${YT_ID}/maxres2.jpg`);
    expect(safetyCalls()).toEqual(['maxres1', 'maxres2']);
  });

  it.each(['violence', 'frightening', 'sexual'] as const)('rejects a frame scoring above 1 on %s', async (dim) => {
    scenario.composition = { 'frame-30': 9, 'frame-50': 6, 'frame-70': 4 };
    scenario.safety['frame-30'] = { ...SAFE, [dim]: 2 };
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toEqual(localUrl);
    // 30s is good enough to short-circuit but fails the floor; the next-best passes.
    expect(safetyCalls()).toEqual(['frame-30', 'frame-50']);
    expect(localThumbContent()).toBe('frame-50');
  });

  it('accepts a frame scoring exactly 1 on every dimension', async () => {
    scenario.safety['frame-50'] = { violence: 1, frightening: 1, sexual: 1 };
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toEqual(localUrl);
    expect(localThumbContent()).toBe('frame-50');
  });

  it('treats a scorer error as a reject, never a pass', async () => {
    scenario.creatorStyle = 'editorial';
    scenario.safety['maxresdefault'] = 'error';
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).not.toContain('i.ytimg.com');
    expect(safetyCalls()).toEqual(['maxresdefault', 'frame-50']);
  });

  it('treats a malformed verdict (pass without scores) as a reject', async () => {
    scenario.creatorStyle = 'editorial';
    scenario.safety['maxresdefault'] = 'malformed';
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).not.toContain('i.ytimg.com');
  });

  it('serves the placeholder, never the creator image, when nothing passes', async () => {
    scenario.creatorStyle = 'editorial';
    for (const key of ['maxresdefault', 'frame-30', 'frame-50', 'frame-70']) {
      scenario.safety[key] = { violence: 3, frightening: 0, sexual: 0 };
    }
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toBe(PLACEHOLDER_URL);
    expect(fs.existsSync(path.join(tmpDir, PLACEHOLDER_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, `${YT_ID}.webp`))).toBe(false);
  });

  it('serves the placeholder when every scorer call errors', async () => {
    scenario.creatorStyle = 'editorial';
    for (const key of ['maxresdefault', 'frame-30', 'frame-50', 'frame-70']) scenario.safety[key] = 'error';
    expect(await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION)).toBe(PLACEHOLDER_URL);
  });

  it('bounds safety checks per video and stops once they are spent', async () => {
    scenario.creatorStyle = 'editorial';
    scenario.autoStyles = { hq1: 'editorial', hq2: 'editorial', hq3: 'editorial' };
    const fail = { violence: 0, frightening: 0, sexual: 3 };
    for (const key of ['maxresdefault', 'maxres1', 'maxres2', 'maxres3', 'frame-30', 'frame-50', 'frame-70']) {
      scenario.safety[key] = fail;
    }
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toBe(PLACEHOLDER_URL);
    expect(safetyCalls()).toHaveLength(MAX_SAFETY_CHECKS);
    // Budget spent on the YT candidates: no frames extracted or scored.
    expect(calls.filter((c) => c.path === '/internal/thumb/score-frame')).toHaveLength(0);
  });

  it('never makes more than the bounded number of Ollama-backed calls per video', async () => {
    scenario.creatorStyle = 'editorial';
    scenario.autoStyles = { hq1: 'editorial' };
    for (const key of ['maxresdefault', 'maxres1', 'frame-30', 'frame-50', 'frame-70']) scenario.safety[key] = 'error';
    await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    // 1 creator style + 3 auto-frame styles + 3 composition scores + safety cap.
    expect(calls.length).toBeLessThanOrEqual(1 + 3 + 3 + MAX_SAFETY_CHECKS);
    expect(safetyCalls().length).toBeLessThanOrEqual(MAX_SAFETY_CHECKS);
  });

  it('re-checks an existing local thumbnail rather than trusting it', async () => {
    fs.writeFileSync(path.join(tmpDir, `${YT_ID}.webp`), 'old-frame');
    scenario.safety['old-frame'] = { violence: 0, frightening: 3, sexual: 0 };
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(safetyCalls()[0]).toBe('old-frame');
    expect(url).toEqual(localUrl);
    expect(localThumbContent()).toBe('frame-50');
  });

  it('reuses an existing local thumbnail that passes', async () => {
    fs.writeFileSync(path.join(tmpDir, `${YT_ID}.webp`), 'old-frame');
    const url = await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION);
    expect(url).toEqual(localUrl);
    expect(safetyCalls()).toEqual(['old-frame']);
    expect(localThumbContent()).toBe('old-frame');
  });

  it('serves the placeholder without any checks when the M4 is unreachable by config', async () => {
    mockConfig.M4_INTERNAL_URL = undefined;
    expect(await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION)).toBe(PLACEHOLDER_URL);
    expect(calls).toHaveLength(0);
  });

  it('returns null rather than a creator image when no placeholder can be served', async () => {
    mockConfig.NGINX_THUMB_BASE_URL = undefined;
    scenario.creatorStyle = 'editorial';
    scenario.safety['maxresdefault'] = 'error';
    expect(await generateThumbnail(YT_ID, '/videos/x.mp4', DURATION)).toBeNull();
  });
});
