import { describe, expect, it, vi } from 'vitest';
import { canShare, shareVideo } from './webShare';

describe('canShare', () => {
  it('returns true when share fn is provided', () => {
    expect(canShare({ share: async () => {} })).toBe(true);
  });

  it('returns false when share is null (unsupported browser)', () => {
    expect(canShare({ share: null })).toBe(false);
  });

  it('returns false when share is undefined', () => {
    expect(canShare({})).toBe(false);
  });
});

describe('shareVideo', () => {
  it('invokes share with url and title when supported', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await shareVideo(
      { url: 'https://www.youtube.com/watch?v=abc123', title: 'A video' },
      { share },
    );
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/watch?v=abc123',
      title: 'A video',
    });
  });

  it('omits title from the payload when not provided', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await shareVideo(
      { url: 'https://www.youtube.com/watch?v=abc123' },
      { share },
    );
    expect(share).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/watch?v=abc123',
    });
  });

  it('omits title when title is null', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await shareVideo(
      { url: 'https://www.youtube.com/watch?v=abc123', title: null },
      { share },
    );
    expect(share).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/watch?v=abc123',
    });
  });

  it('is a no-op when share is unavailable', async () => {
    await expect(
      shareVideo({ url: 'https://www.youtube.com/watch?v=abc123' }, { share: null }),
    ).resolves.toBeUndefined();
  });

  it('swallows AbortError (user dismissed the share sheet)', async () => {
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    const share = vi.fn().mockRejectedValue(abort);
    await expect(
      shareVideo({ url: 'https://www.youtube.com/watch?v=abc123' }, { share }),
    ).resolves.toBeUndefined();
  });

  it('re-throws non-abort errors', async () => {
    const share = vi.fn().mockRejectedValue(new Error('permission denied'));
    await expect(
      shareVideo({ url: 'https://www.youtube.com/watch?v=abc123' }, { share }),
    ).rejects.toThrow('permission denied');
  });
});
