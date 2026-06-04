import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mutable mock config so individual tests can drop the key. Hoisted so the
// vi.mock factory (itself hoisted) can reference it.
const mockConfig = vi.hoisted(() => ({ YOUTUBE_API_KEY: 'test-key' as string | undefined }));
vi.mock('./config', () => ({ config: mockConfig }));

import {
  parseIso8601Duration,
  searchVideosWithDates,
  fetchVideoMetadata,
  flatPlaylistChannel,
  channelInfo,
  videoDuration,
  getQuotaUsage,
  YoutubeApiError,
} from './youtubeapi';

// Minimal Response-like stub for the global fetch mock.
function fetchResult(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  mockConfig.YOUTUBE_API_KEY = 'test-key';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // AbortSignal.timeout exists in Node LTS; nothing to stub.
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseIso8601Duration', () => {
  it('parses hours, minutes and seconds', () => {
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723);
  });
  it('parses seconds-only and minutes-only', () => {
    expect(parseIso8601Duration('PT45S')).toBe(45);
    expect(parseIso8601Duration('PT2M')).toBe(120);
  });
  it('parses day component', () => {
    expect(parseIso8601Duration('P1DT1H')).toBe(90_000);
  });
  it('returns null for zero / live placeholders', () => {
    expect(parseIso8601Duration('PT0S')).toBeNull();
    expect(parseIso8601Duration('P0D')).toBeNull();
  });
  it('returns null for unparseable input', () => {
    expect(parseIso8601Duration('garbage')).toBeNull();
    expect(parseIso8601Duration('')).toBeNull();
  });
});

describe('searchVideosWithDates', () => {
  // Route the two-step search→videos flow by URL.
  function routeFetch(opts: { search: unknown; videos: unknown }) {
    fetchMock.mockImplementation((url: URL) => {
      const path = url.toString();
      if (path.includes('/youtube/v3/search')) return Promise.resolve(fetchResult(opts.search));
      if (path.includes('/youtube/v3/videos')) return Promise.resolve(fetchResult(opts.videos));
      throw new Error(`unexpected url ${path}`);
    });
  }

  it('maps fields, converts publishedAt to YYYYMMDD, and preserves relevance order', async () => {
    routeFetch({
      search: { items: [{ id: { videoId: 'b' } }, { id: { videoId: 'a' } }] },
      videos: {
        items: [
          // returned out of order — output must follow search order (b, a)
          {
            id: 'a',
            snippet: {
              title: 'Alpha',
              channelTitle: 'Chan A',
              channelId: 'UCa',
              publishedAt: '2026-01-15T10:30:00Z',
              liveBroadcastContent: 'none',
              thumbnails: { high: { url: 'http://a/high' }, default: { url: 'http://a/def' } },
            },
            contentDetails: { duration: 'PT10M' },
            statistics: { viewCount: '1234' },
          },
          {
            id: 'b',
            snippet: {
              title: 'Bravo',
              channelTitle: 'Chan B',
              channelId: 'UCb',
              publishedAt: '2026-02-20T00:01:00Z',
              liveBroadcastContent: 'none',
              thumbnails: { maxres: { url: 'http://b/max' }, high: { url: 'http://b/high' } },
            },
            contentDetails: { duration: 'PT1H' },
            statistics: { viewCount: '99' },
          },
        ],
      },
    });

    const results = await searchVideosWithDates('robots', 10);
    expect(results.map((r) => r.videoId)).toEqual(['b', 'a']);
    expect(results[0]).toMatchObject({
      videoId: 'b',
      title: 'Bravo',
      channel: 'Chan B',
      durationSecs: 3600,
      viewCount: 99,
      uploadDate: '20260220',
      thumbnailUrl: 'http://b/max',
      liveStatus: null,
      url: 'https://www.youtube.com/watch?v=b',
    });
    expect(results[1]).toMatchObject({
      videoId: 'a',
      uploadDate: '20260115',
      durationSecs: 600,
      thumbnailUrl: 'http://a/high',
    });
  });

  it('applies a publishedAfter bound and caps maxResults at 50', async () => {
    routeFetch({ search: { items: [] }, videos: { items: [] } });
    await searchVideosWithDates('cats', 200);
    const url = (fetchMock.mock.calls[0]![0] as URL).toString();
    expect(url).toContain('maxResults=50');
    expect(url).toContain('publishedAfter=');
    expect(url).toContain('type=video');
  });

  it('drops search ids the videos.list omits (private/removed)', async () => {
    routeFetch({
      search: { items: [{ id: { videoId: 'gone' } }, { id: { videoId: 'ok' } }] },
      videos: { items: [{ id: 'ok', snippet: { title: 'OK' }, contentDetails: { duration: 'PT5M' } }] },
    });
    const results = await searchVideosWithDates('x');
    expect(results.map((r) => r.videoId)).toEqual(['ok']);
  });

  it('maps live broadcast content to yt-dlp live_status values', async () => {
    routeFetch({
      search: { items: [{ id: { videoId: 'live1' } }] },
      videos: { items: [{ id: 'live1', snippet: { title: 'L', liveBroadcastContent: 'live' } }] },
    });
    const [r] = await searchVideosWithDates('x');
    expect(r?.liveStatus).toBe('is_live');
  });

  it('returns empty without calling videos.list when search yields no ids', async () => {
    routeFetch({ search: { items: [] }, videos: { items: [] } });
    const results = await searchVideosWithDates('nothing');
    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('raises a quota-flagged YoutubeApiError on 403 quotaExceeded', async () => {
    fetchMock.mockResolvedValue(
      fetchResult('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { ok: false, status: 403 }),
    );
    await expect(searchVideosWithDates('x')).rejects.toMatchObject({
      name: 'YoutubeApiError',
      quotaExceeded: true,
    });
  });

  it('raises a non-quota YoutubeApiError on other HTTP errors', async () => {
    fetchMock.mockResolvedValue(fetchResult('nope', { ok: false, status: 500 }));
    const err = await searchVideosWithDates('x').catch((e) => e);
    expect(err).toBeInstanceOf(YoutubeApiError);
    expect((err as YoutubeApiError).quotaExceeded).toBe(false);
  });

  it('raises YoutubeApiError when fetch rejects (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(searchVideosWithDates('x')).rejects.toBeInstanceOf(YoutubeApiError);
  });

  it('throws when the API key is not configured', async () => {
    mockConfig.YOUTUBE_API_KEY = undefined;
    await expect(searchVideosWithDates('x')).rejects.toBeInstanceOf(YoutubeApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchVideoMetadata', () => {
  it('batches ids into pages of 50', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    fetchMock.mockResolvedValue(fetchResult({ items: [] }));
    await fetchVideoMetadata(ids);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 50 + 50 + 20
  });

  it('parses view counts and durations, leaving unknowns null', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({
        items: [
          { id: 'a', snippet: { title: 'A' }, contentDetails: { duration: 'PT3M20S' }, statistics: { viewCount: '500' } },
          { id: 'b', snippet: { title: 'B' }, statistics: {} },
        ],
      }),
    );
    const map = await fetchVideoMetadata(['a', 'b']);
    expect(map.get('a')).toMatchObject({ durationSecs: 200, viewCount: 500 });
    expect(map.get('b')).toMatchObject({ durationSecs: null, viewCount: null });
  });

  it('returns an empty map for no ids without calling the API', async () => {
    const map = await fetchVideoMetadata([]);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flatPlaylistChannel', () => {
  // Route playlistItems → videos by URL.
  function routeFetch(opts: { playlist: unknown; videos: unknown }) {
    fetchMock.mockImplementation((url: URL) => {
      const path = url.toString();
      if (path.includes('/youtube/v3/playlistItems')) return Promise.resolve(fetchResult(opts.playlist));
      if (path.includes('/youtube/v3/videos')) return Promise.resolve(fetchResult(opts.videos));
      throw new Error(`unexpected url ${path}`);
    });
  }

  it('derives the UU uploads playlist id from a UC channel id', async () => {
    routeFetch({ playlist: { items: [] }, videos: { items: [] } });
    await flatPlaylistChannel('UCabc123');
    const url = (fetchMock.mock.calls[0]![0] as URL).toString();
    expect(url).toContain('playlistId=UUabc123');
  });

  it('maps playlist ids through videos.list, preserving order and live status', async () => {
    routeFetch({
      playlist: {
        items: [
          { contentDetails: { videoId: 'v1' } },
          { contentDetails: { videoId: 'v2' } },
        ],
      },
      videos: {
        items: [
          { id: 'v2', snippet: { title: 'Two', liveBroadcastContent: 'live' }, contentDetails: { duration: 'PT2M' } },
          { id: 'v1', snippet: { title: 'One' }, contentDetails: { duration: 'PT1M' } },
        ],
      },
    });
    const out = await flatPlaylistChannel('UCx');
    expect(out.map((e) => e.videoId)).toEqual(['v1', 'v2']);
    expect(out[0]).toMatchObject({ title: 'One', durationSecs: 60, liveStatus: null });
    expect(out[1]).toMatchObject({ title: 'Two', durationSecs: 120, liveStatus: 'is_live' });
  });

  it('drops playlist ids the videos.list omits', async () => {
    routeFetch({
      playlist: { items: [{ contentDetails: { videoId: 'gone' } }, { contentDetails: { videoId: 'ok' } }] },
      videos: { items: [{ id: 'ok', snippet: { title: 'OK' }, contentDetails: { duration: 'PT5M' } }] },
    });
    const out = await flatPlaylistChannel('UCx');
    expect(out.map((e) => e.videoId)).toEqual(['ok']);
  });

  it('pages until nextPageToken is absent, then fetches durations once', async () => {
    let page = 0;
    fetchMock.mockImplementation((url: URL) => {
      const path = url.toString();
      if (path.includes('/youtube/v3/playlistItems')) {
        page += 1;
        return Promise.resolve(
          fetchResult(
            page === 1
              ? { items: [{ contentDetails: { videoId: 'a' } }], nextPageToken: 'p2' }
              : { items: [{ contentDetails: { videoId: 'b' } }] },
          ),
        );
      }
      if (path.includes('/youtube/v3/videos')) {
        return Promise.resolve(
          fetchResult({
            items: [
              { id: 'a', snippet: { title: 'A' }, contentDetails: { duration: 'PT1M' } },
              { id: 'b', snippet: { title: 'B' }, contentDetails: { duration: 'PT1M' } },
            ],
          }),
        );
      }
      throw new Error(`unexpected url ${path}`);
    });
    const out = await flatPlaylistChannel('UCx');
    expect(out.map((e) => e.videoId)).toEqual(['a', 'b']);
    expect(page).toBe(2);
  });

  it('returns empty without a videos.list call when the playlist is empty', async () => {
    routeFetch({ playlist: { items: [] }, videos: { items: [] } });
    const out = await flatPlaylistChannel('UCx');
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('channelInfo', () => {
  it('returns the description and the largest thumbnail', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({
        items: [
          {
            snippet: {
              description: 'A channel about robots',
              thumbnails: { high: { url: 'http://c/high' }, default: { url: 'http://c/def' } },
            },
          },
        ],
      }),
    );
    const info = await channelInfo('UCx');
    expect(info).toEqual({ description: 'A channel about robots', avatarUrl: 'http://c/high' });
  });

  it('collapses a blank description to null', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({ items: [{ snippet: { description: '   ', thumbnails: {} } }] }),
    );
    const info = await channelInfo('UCx');
    expect(info.description).toBeNull();
    expect(info.avatarUrl).toBeNull();
  });

  it('throws when the channel is missing', async () => {
    fetchMock.mockResolvedValue(fetchResult({ items: [] }));
    await expect(channelInfo('UCx')).rejects.toBeInstanceOf(YoutubeApiError);
  });
});

describe('videoDuration', () => {
  it('returns the parsed duration in seconds', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({ items: [{ id: 'v', snippet: { title: 'V' }, contentDetails: { duration: 'PT3M20S' } }] }),
    );
    expect(await videoDuration('v')).toBe(200);
  });

  it('throws when the duration is missing or non-positive', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({ items: [{ id: 'v', snippet: { title: 'V' }, contentDetails: { duration: 'P0D' } }] }),
    );
    await expect(videoDuration('v')).rejects.toBeInstanceOf(YoutubeApiError);
  });

  it('throws when the video is absent from the response', async () => {
    fetchMock.mockResolvedValue(fetchResult({ items: [] }));
    await expect(videoDuration('v')).rejects.toBeInstanceOf(YoutubeApiError);
  });
});

describe('quota accounting', () => {
  it('bills search.list at 100 units and videos.list at 1', async () => {
    fetchMock.mockImplementation((url: URL) => {
      const path = url.toString();
      if (path.includes('/youtube/v3/search')) {
        return Promise.resolve(fetchResult({ items: [{ id: { videoId: 'a' } }] }));
      }
      return Promise.resolve(
        fetchResult({ items: [{ id: 'a', snippet: { title: 'A' }, contentDetails: { duration: 'PT1M' } }] }),
      );
    });
    const before = getQuotaUsage().units;
    await searchVideosWithDates('x'); // 100 (search) + 1 (videos)
    expect(getQuotaUsage().units - before).toBe(101);
  });

  it('does not bill a failed (quota-exceeded) call', async () => {
    fetchMock.mockResolvedValue(
      fetchResult('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { ok: false, status: 403 }),
    );
    const before = getQuotaUsage().units;
    await videoDuration('v').catch(() => undefined);
    expect(getQuotaUsage().units).toBe(before);
  });
});
