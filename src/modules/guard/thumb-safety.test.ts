import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

import { ollamaGenerate } from '../../ollama';
import { logger } from '../../logger';
import {
  THUMB_SAFETY_VERSION,
  passesThumbSafetyFloor,
  scoreThumbnailSafety,
} from './thumb-safety';

function modelReply(v: number, f: number, s: number): string {
  return JSON.stringify({
    violence: { reason: 'a', score: v },
    frightening: { reason: 'b', score: f },
    sexual: { reason: 'c', score: s },
  });
}

beforeEach(() => {
  vi.mocked(ollamaGenerate).mockReset();
  vi.mocked(logger.info).mockClear();
});

describe('scoreThumbnailSafety', () => {
  it('passes an image scoring 0-1 on every dimension', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(modelReply(1, 0, 1));
    const v = await scoreThumbnailSafety('aW1n');
    expect(v).toMatchObject({ version: THUMB_SAFETY_VERSION, pass: true });
    expect(v.scores?.violence.score).toBe(1);
  });

  it.each([
    ['violence', modelReply(2, 0, 0)],
    ['frightening', modelReply(0, 2, 0)],
    ['sexual', modelReply(0, 0, 3)],
  ])('fails an image scoring above 1 on %s', async (_dim, reply) => {
    vi.mocked(ollamaGenerate).mockResolvedValue(reply);
    const v = await scoreThumbnailSafety('aW1n');
    expect(v.pass).toBe(false);
    expect(v.scores).not.toBeNull();
  });

  it('sends the image with a structured-output schema, deterministic and without thinking', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(modelReply(0, 0, 0));
    await scoreThumbnailSafety('aW1n');
    const [, model, images, options, format] = vi.mocked(ollamaGenerate).mock.calls[0]!;
    expect(model).toBe('gemma4:e4b');
    expect(images).toEqual(['aW1n']);
    expect(options).toMatchObject({ temperature: 0, think: false });
    expect(format).toMatchObject({ required: ['violence', 'frightening', 'sexual'] });
  });

  it('fails on a model error', async () => {
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));
    const v = await scoreThumbnailSafety('aW1n');
    expect(v).toEqual({ version: THUMB_SAFETY_VERSION, pass: false, scores: null, error: 'model_error' });
  });

  it.each([
    ['prose', 'looks fine to me'],
    ['missing dimension', JSON.stringify({ violence: { reason: 'a', score: 0 }, frightening: { reason: 'b', score: 0 } })],
    ['out-of-range score', modelReply(0, 0, 4)],
    ['fractional score', modelReply(0.5, 0, 0)],
    ['string score', JSON.stringify({ violence: { score: '0' }, frightening: { score: 0 }, sexual: { score: 0 } })],
  ])('fails on an unparseable reply (%s)', async (_label, reply) => {
    vi.mocked(ollamaGenerate).mockResolvedValue(reply);
    const v = await scoreThumbnailSafety('aW1n');
    expect(v).toMatchObject({ pass: false, scores: null, error: 'parse_error' });
  });

  it('logs scores but not the model reasons', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(JSON.stringify({
      violence: { reason: 'SECRET-REASON', score: 0 },
      frightening: { reason: 'SECRET-REASON', score: 0 },
      sexual: { reason: 'SECRET-REASON', score: 0 },
    }));
    await scoreThumbnailSafety('aW1n', { youtubeId: 'abcdefghijk' });
    const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(logged).toContain('"violence":0');
    expect(logged).not.toContain('SECRET-REASON');
  });
});

describe('passesThumbSafetyFloor', () => {
  it('fails null scores', () => {
    expect(passesThumbSafetyFloor(null)).toBe(false);
  });
});
