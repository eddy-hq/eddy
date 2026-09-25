import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({ DISCOVERY_SOURCE: 'api' as 'api' | 'ytdlp' }));
vi.mock('./config', () => ({ config: mockConfig }));

const apiSearch = vi.hoisted(() => vi.fn());
const ytdlpSearch = vi.hoisted(() => vi.fn());
vi.mock('./youtubeapi', () => ({ searchVideosFlat: apiSearch }));
vi.mock('./ytdlp', () => ({ searchVideosFlat: ytdlpSearch }));

import { searchVideosFlatStrict } from './discovery-metadata';

beforeEach(() => {
  apiSearch.mockReset().mockResolvedValue([]);
  ytdlpSearch.mockReset().mockResolvedValue([]);
});

describe('searchVideosFlatStrict', () => {
  it('uses the Data API with safeSearch=strict under the api source', async () => {
    mockConfig.DISCOVERY_SOURCE = 'api';
    const out = await searchVideosFlatStrict('robots');
    expect(out).toEqual([]);
    expect(apiSearch).toHaveBeenCalledWith('robots', undefined, { safeSearch: 'strict' });
    expect(ytdlpSearch).not.toHaveBeenCalled();
  });

  it('returns null without scraping under the yt-dlp source (no safe-search control)', async () => {
    mockConfig.DISCOVERY_SOURCE = 'ytdlp';
    const out = await searchVideosFlatStrict('robots');
    expect(out).toBeNull();
    expect(ytdlpSearch).not.toHaveBeenCalled();
    expect(apiSearch).not.toHaveBeenCalled();
  });
});
