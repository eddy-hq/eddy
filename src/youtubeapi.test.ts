import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mutable mock config so individual tests can drop the key. Hoisted so the
// vi.mock factory (itself hoisted) can reference it.
const mockConfig = vi.hoisted(() => ({ YOUTUBE_API_KEY: 'test-key' as string | undefined }));
vi.mock('./config', () => ({ config: mockConfig }));

// Stub the logger so the quota-threshold test can assert the 80% warn fires.
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { logger } from './logger';

import {
  parseIso8601Duration,
  searchVideosWithDates,
  searchVideosFlat,
  searchChannelsFlat,
  fetchVideoMetadata,
  flatPlaylistChannel,
  recentUploads,
  channelInfo,
  channelIdentity,
  videoDuration,
  videoDurations,
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

describe('searchVideosFlat', () => {
  function routeFetch(opts: { search: unknown; videos: unknown }) {
    fetchMock.mockImplementation((url: URL) => {
      const path = url.toString();
      if (path.includes('/youtube/v3/search')) return Promise.resolve(fetchResult(opts.search));
      if (path.includes('/youtube/v3/videos')) return Promise.resolve(fetchResult(opts.videos));
      throw new Error(`unexpected url ${path}`);
    });
  }

  it('projects the flat search-card shape and preserves relevance order', async () => {
    routeFetch({
      search: { items: [{ id: { videoId: 'b' } }, { id: { videoId: 'a' } }] },
      videos: {
        items: [
          {
            id: 'a',
            snippet: {
              title: 'Alpha',
              channelTitle: 'Chan A',
              channelId: 'UCa',
              thumbnails: { high: { url: 'http://a/high' } },
            },
            contentDetails: { duration: 'PT10M' },
          },
          {
            id: 'b',
            snippet: {
              title: 'Bravo',
              channelTitle: 'Chan B',
              channelId: 'UCb',
              thumbnails: { maxres: { url: 'http://b/max' } },
            },
            contentDetails: { duration: 'PT1H' },
          },
        ],
      },
    });

    const results = await searchVideosFlat('robots');
    expect(results.map((r) => r.videoId)).toEqual(['b', 'a']);
    expect(results[0]).toEqual({
      videoId: 'b',
      title: 'Bravo',
      channel: 'Chan B',
      channelId: 'UCb',
      durationSecs: 3600,
      thumbnailUrl: 'http://b/max',
      url: 'https://www.youtube.com/watch?v=b',
    });
  });

  it('does not apply a publishedAfter freshness bound', async () => {
    routeFetch({ search: { items: [] }, videos: { items: [] } });
    await searchVideosFlat('old documentary', 200);
    const url = (fetchMock.mock.calls[0]![0] as URL).toString();
    expect(url).toContain('type=video');
    expect(url).toContain('maxResults=50');
    expect(url).not.toContain('publishedAfter');
  });

  it('leaves safeSearch at the YouTube default when not asked for strict', async () => {
    routeFetch({ search: { items: [] }, videos: { items: [] } });
    await searchVideosFlat('robots');
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.searchParams.has('safeSearch')).toBe(false);
  });

  it('sends safeSearch=strict when asked (kid searches)', async () => {
    routeFetch({ search: { items: [] }, videos: { items: [] } });
    await searchVideosFlat('robots', 10, { safeSearch: 'strict' });
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.searchParams.get('safeSearch')).toBe('strict');
  });

  it('drops search ids the videos.list omits', async () => {
    routeFetch({
      search: { items: [{ id: { videoId: 'gone' } }, { id: { videoId: 'ok' } }] },
      videos: { items: [{ id: 'ok', snippet: { title: 'OK' }, contentDetails: { duration: 'PT5M' } }] },
    });
    const results = await searchVideosFlat('x');
    expect(results.map((r) => r.videoId)).toEqual(['ok']);
  });

  it('returns empty without calling videos.list when search yields no ids', async () => {
    routeFetch({ search: { items: [] }, videos: { items: [] } });
    const results = await searchVideosFlat('nothing');
    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('searchChannelsFlat', () => {
  function routeFetch(opts: { search: unknown; channels: unknown }) {
    fetchMock.mockImplementation((url: URL) => {
      const path = url.toString();
      if (path.includes('/youtube/v3/search')) return Promise.resolve(fetchResult(opts.search));
      if (path.includes('/youtube/v3/channels')) return Promise.resolve(fetchResult(opts.channels));
      throw new Error(`unexpected url ${path}`);
    });
  }

  it('projects channel records, preserves order, and builds a handle URL from customUrl', async () => {
    routeFetch({
      search: { items: [{ id: { channelId: 'UCb' } }, { id: { channelId: 'UCa' } }] },
      channels: {
        items: [
          { id: 'UCa', snippet: { title: 'Chan A', customUrl: '@chana' } },
          { id: 'UCb', snippet: { title: 'Chan B', customUrl: '@chanb' } },
        ],
      },
    });
    const results = await searchChannelsFlat('robots');
    expect(results).toEqual([
      { channelId: 'UCb', channelName: 'Chan B', channelUrl: 'https://www.youtube.com/@chanb' },
      { channelId: 'UCa', channelName: 'Chan A', channelUrl: 'https://www.youtube.com/@chana' },
    ]);
  });

  it('falls back to the /channel/ URL when customUrl is absent or not a handle', async () => {
    routeFetch({
      search: { items: [{ id: { channelId: 'UCnone' } }, { id: { channelId: 'UClegacy' } }] },
      channels: {
        items: [
          { id: 'UCnone', snippet: { title: 'No Handle' } },
          { id: 'UClegacy', snippet: { title: 'Legacy', customUrl: 'legacyvanity' } },
        ],
      },
    });
    const results = await searchChannelsFlat('x');
    expect(results).toEqual([
      { channelId: 'UCnone', channelName: 'No Handle', channelUrl: 'https://www.youtube.com/channel/UCnone' },
      { channelId: 'UClegacy', channelName: 'Legacy', channelUrl: 'https://www.youtube.com/channel/UClegacy' },
    ]);
  });

  it('requests type=channel and caps maxResults at 50', async () => {
    routeFetch({ search: { items: [] }, channels: { items: [] } });
    await searchChannelsFlat('x', 200);
    const url = (fetchMock.mock.calls[0]![0] as URL).toString();
    expect(url).toContain('type=channel');
    expect(url).toContain('maxResults=50');
  });

  it('de-duplicates repeated channel ids from the search page', async () => {
    routeFetch({
      search: { items: [{ id: { channelId: 'UCa' } }, { id: { channelId: 'UCa' } }, { id: { channelId: 'UCb' } }] },
      channels: {
        items: [
          { id: 'UCa', snippet: { title: 'A', customUrl: '@a' } },
          { id: 'UCb', snippet: { title: 'B', customUrl: '@b' } },
        ],
      },
    });
    const results = await searchChannelsFlat('x');
    expect(results.map((c) => c.channelId)).toEqual(['UCa', 'UCb']);
  });

  it('drops channel ids the channels.list omits', async () => {
    routeFetch({
      search: { items: [{ id: { channelId: 'gone' } }, { id: { channelId: 'UCok' } }] },
      channels: { items: [{ id: 'UCok', snippet: { title: 'OK', customUrl: '@ok' } }] },
    });
    const results = await searchChannelsFlat('x');
    expect(results.map((c) => c.channelId)).toEqual(['UCok']);
  });

  it('returns empty without calling channels.list when search yields no ids', async () => {
    routeFetch({ search: { items: [] }, channels: { items: [] } });
    const results = await searchChannelsFlat('nothing');
    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('requests the status part alongside snippet, contentDetails and statistics', async () => {
    fetchMock.mockResolvedValue(fetchResult({ items: [] }));
    await fetchVideoMetadata(['a']);
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('part')).toBe('snippet,contentDetails,statistics,status');
  });

  it('maps description, tags, category, age restriction and made-for-kids', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({
        items: [
          {
            id: 'a',
            snippet: { title: 'A', description: 'About A', tags: ['one', 'two'], categoryId: '27' },
            contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } },
            status: { madeForKids: false },
          },
          {
            id: 'b',
            snippet: { title: 'B', description: 'About B', categoryId: '10' },
            contentDetails: { contentRating: {} },
            status: { madeForKids: true },
          },
        ],
      }),
    );
    const map = await fetchVideoMetadata(['a', 'b']);
    expect(map.get('a')).toMatchObject({
      description: 'About A',
      tags: ['one', 'two'],
      categoryId: '27',
      ageRestricted: true,
      madeForKids: false,
    });
    expect(map.get('b')).toMatchObject({
      tags: [],
      categoryId: '10',
      ageRestricted: false,
      madeForKids: true,
    });
  });

  it('leaves guard fields empty or unknown when the API omits them', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({ items: [{ id: 'a', snippet: { title: 'A', description: '   ' } }] }),
    );
    const map = await fetchVideoMetadata(['a']);
    expect(map.get('a')).toMatchObject({
      description: null,
      tags: [],
      categoryId: null,
      ageRestricted: false,
      madeForKids: null,
    });
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

describe('recentUploads', () => {
  it('reads one page of the UU uploads playlist — a single 1-unit call', async () => {
    fetchMock.mockResolvedValue(fetchResult({ items: [] }));
    await recentUploads('UCabc123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = (fetchMock.mock.calls[0]![0] as URL).toString();
    expect(url).toContain('/youtube/v3/playlistItems');
    expect(url).toContain('playlistId=UUabc123');
    expect(url).toContain('part=snippet%2CcontentDetails');
  });

  it("maps title, thumbnail and the video's own publish time, preserving order", async () => {
    fetchMock.mockResolvedValue(
      fetchResult({
        items: [
          {
            snippet: {
              title: 'Newest',
              publishedAt: '2026-09-21T09:00:00Z',
              thumbnails: { default: { url: 'small' }, high: { url: 'big' } },
            },
            contentDetails: { videoId: 'v1', videoPublishedAt: '2026-09-20T08:00:00Z' },
          },
          {
            snippet: { title: 'Older' },
            contentDetails: { videoId: 'v2', videoPublishedAt: '2026-09-18T08:00:00Z' },
          },
        ],
      }),
    );
    const out = await recentUploads('UCx');
    expect(out).toEqual([
      { videoId: 'v1', title: 'Newest', publishedAt: '2026-09-20T08:00:00Z', thumbnailUrl: 'big' },
      { videoId: 'v2', title: 'Older', publishedAt: '2026-09-18T08:00:00Z', thumbnailUrl: null },
    ]);
  });

  it('drops private / deleted items, which carry no videoPublishedAt', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({
        items: [
          { snippet: { title: 'Private video' }, contentDetails: { videoId: 'gone' } },
          { snippet: { title: 'OK' }, contentDetails: { videoId: 'ok', videoPublishedAt: '2026-09-20T08:00:00Z' } },
        ],
      }),
    );
    const out = await recentUploads('UCx');
    expect(out.map((v) => v.videoId)).toEqual(['ok']);
  });

  it('flags quota exhaustion so the poll pass can stand down', async () => {
    fetchMock.mockResolvedValue(fetchResult('quotaExceeded', { ok: false, status: 403 }));
    await expect(recentUploads('UCx')).rejects.toMatchObject({ quotaExceeded: true });
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

describe('channelIdentity', () => {
  const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';

  it('looks a handle up with channels.list forHandle', async () => {
    fetchMock.mockResolvedValue(fetchResult({ items: [{ id: CHANNEL_ID, snippet: { title: 'Placeholder channel' } }] }));
    const out = await channelIdentity({ kind: 'handle', handle: '@placeholder' });
    expect(out).toEqual({ channelId: CHANNEL_ID, displayName: 'Placeholder channel' });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toMatch(/\/channels$/);
    expect(url.searchParams.get('forHandle')).toBe('@placeholder');
  });

  it("reads a video's channel from videos.list", async () => {
    fetchMock.mockResolvedValue(fetchResult({
      items: [{ id: 'abcdefghijk', snippet: { title: 'V', channelTitle: 'Placeholder channel', channelId: CHANNEL_ID }, contentDetails: { duration: 'PT3M' } }],
    }));
    expect(await channelIdentity({ kind: 'video', videoId: 'abcdefghijk' }))
      .toEqual({ channelId: CHANNEL_ID, displayName: 'Placeholder channel' });
  });

  it('returns null when nothing matches', async () => {
    fetchMock.mockResolvedValue(fetchResult({ items: [] }));
    expect(await channelIdentity({ kind: 'channel_id', channelId: CHANNEL_ID })).toBeNull();
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

describe('videoDurations (batched)', () => {
  it('maps each id to its positive duration in one call', async () => {
    fetchMock.mockResolvedValue(
      fetchResult({
        items: [
          { id: 'a', snippet: { title: 'A' }, contentDetails: { duration: 'PT1M' } },
          { id: 'b', snippet: { title: 'B' }, contentDetails: { duration: 'PT2M30S' } },
        ],
      }),
    );
    const map = await videoDurations(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one batched videos.list
    expect(map.get('a')).toBe(60);
    expect(map.get('b')).toBe(150);
    expect(map.size).toBe(2);
  });

  it('omits ids the API drops and ids with a non-positive duration', async () => {
    // 'b' requested but absent (private/removed); 'c' present but P0D (live).
    fetchMock.mockResolvedValue(
      fetchResult({
        items: [
          { id: 'a', snippet: { title: 'A' }, contentDetails: { duration: 'PT45S' } },
          { id: 'c', snippet: { title: 'C' }, contentDetails: { duration: 'P0D' } },
        ],
      }),
    );
    const map = await videoDurations(['a', 'b', 'c']);
    expect(map.get('a')).toBe(45);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(false);
  });

  it('makes no call and returns an empty map for no ids', async () => {
    const map = await videoDurations([]);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a quota-exceeded error rather than returning a partial map', async () => {
    fetchMock.mockResolvedValue(
      fetchResult('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { ok: false, status: 403 }),
    );
    await expect(videoDurations(['a'])).rejects.toMatchObject({ quotaExceeded: true });
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

  it('warns exactly once when the day crosses 80% of the free tier', async () => {
    // search.list (100) + videos.list (1) = 101 units/call; loop past the
    // 8,000-unit (80% of 10k) line, then keep going to prove the warn is
    // one-shot per day, not per-call. No notification event by design (ADR-0011).
    fetchMock.mockImplementation((url: URL) => {
      const path = url.toString();
      if (path.includes('/youtube/v3/search')) {
        return Promise.resolve(fetchResult({ items: [{ id: { videoId: 'a' } }] }));
      }
      return Promise.resolve(
        fetchResult({ items: [{ id: 'a', snippet: { title: 'A' }, contentDetails: { duration: 'PT1M' } }] }),
      );
    });
    vi.mocked(logger.warn).mockClear();
    while (getQuotaUsage().units < 8_000) await searchVideosWithDates('x');
    await searchVideosWithDates('x'); // still over the line — must not re-warn
    await searchVideosWithDates('x');

    const thresholdWarns = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => typeof c[1] === 'string' && c[1].includes('80%'));
    expect(thresholdWarns).toHaveLength(1);
    expect(getQuotaUsage().units).toBeLessThan(10_000); // warned before the ceiling
  });
});
