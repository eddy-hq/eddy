import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config', () => ({
  config: { YTDLP_BIN_M4: '/fake/yt-dlp', YTDLP_BIN: '/fake/yt-dlp', NODE_ENV: 'test' },
}));

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    try {
      const result = execFileMock(file, args, opts) as { stdout: string; stderr?: string };
      cb(null, { stdout: result.stdout, stderr: result.stderr ?? '' });
    } catch (err) {
      cb(err as Error, { stdout: '', stderr: '' });
    }
  },
}));

import { parseYtdlpLines, searchVideosFlat, YtdlpError, videoDuration, channelInfo } from './ytdlp';

describe('parseYtdlpLines', () => {
  it('skips empty lines', () => {
    const stdout = '\n{"id":"a"}\n\n{"id":"b"}\n\n';
    const records = parseYtdlpLines(stdout);
    expect(records).toHaveLength(2);
    expect(records[0]?.['id']).toBe('a');
    expect(records[1]?.['id']).toBe('b');
  });

  it('skips malformed JSON lines but keeps valid ones', () => {
    const stdout = '{"id":"good"}\nnot json at all\n{"id":"also good"}\n';
    const records = parseYtdlpLines(stdout);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r['id'])).toEqual(['good', 'also good']);
  });

  it('returns parsed records that may be missing id (projection drops them)', () => {
    const stdout = '{"id":"keep"}\n{"title":"no id here"}\n{"id":"keep2"}\n';
    const records = parseYtdlpLines(stdout);
    // Parser keeps the missing-id record; projection at the call site filters it.
    expect(records).toHaveLength(3);
  });

  it('returns empty array on empty stdout', () => {
    expect(parseYtdlpLines('')).toEqual([]);
    expect(parseYtdlpLines('\n\n\n')).toEqual([]);
  });
});

describe('searchVideosFlat', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('drops records missing an id during projection', async () => {
    execFileMock.mockReturnValue({
      stdout: [
        JSON.stringify({ id: 'vid1', title: 'A', channel_id: 'c1' }),
        JSON.stringify({ title: 'no id', channel_id: 'c2' }),
        JSON.stringify({ id: 'vid2', title: 'B', channel_id: 'c3' }),
      ].join('\n'),
    });
    const results = await searchVideosFlat('cats');
    expect(results.map((r) => r.videoId)).toEqual(['vid1', 'vid2']);
  });

  it('picks a thumbnail with height ≥ 180 if available', async () => {
    execFileMock.mockReturnValue({
      stdout: JSON.stringify({
        id: 'vid1',
        title: 'A',
        channel_id: 'c1',
        thumbnails: [
          { url: 'http://small', height: 60 },
          { url: 'http://big', height: 360 },
        ],
      }),
    });
    const [r] = await searchVideosFlat('cats');
    expect(r?.thumbnailUrl).toBe('http://big');
  });

  it('falls back to first thumbnail when none meet the height threshold', async () => {
    execFileMock.mockReturnValue({
      stdout: JSON.stringify({
        id: 'vid1',
        title: 'A',
        channel_id: 'c1',
        thumbnails: [{ url: 'http://tiny', height: 60 }],
      }),
    });
    const [r] = await searchVideosFlat('cats');
    expect(r?.thumbnailUrl).toBe('http://tiny');
  });

  it('throws YtdlpError when execFile fails', async () => {
    execFileMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(searchVideosFlat('cats')).rejects.toBeInstanceOf(YtdlpError);
  });
});

describe('channelInfo', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('returns description and the largest avatar from the playlist root JSON', async () => {
    execFileMock.mockReturnValue({
      stdout: JSON.stringify({
        description: 'A channel about science.',
        thumbnails: [
          { url: 'http://small', height: 60 },
          { url: 'http://big', height: 800 },
          { url: 'http://medium', height: 240 },
        ],
      }),
    });
    const info = await channelInfo('UC123');
    expect(info.description).toBe('A channel about science.');
    expect(info.avatarUrl).toBe('http://big');
  });

  it('treats an empty/whitespace description as null', async () => {
    execFileMock.mockReturnValue({
      stdout: JSON.stringify({ description: '   ', thumbnails: [{ url: 'http://avatar', height: 200 }] }),
    });
    const info = await channelInfo('UC123');
    expect(info.description).toBeNull();
    expect(info.avatarUrl).toBe('http://avatar');
  });

  it('returns null avatarUrl when no thumbnails are present', async () => {
    execFileMock.mockReturnValue({
      stdout: JSON.stringify({ description: 'No avatar here.' }),
    });
    const info = await channelInfo('UC123');
    expect(info.avatarUrl).toBeNull();
  });

  it('throws YtdlpError when the playlist root JSON is missing', async () => {
    execFileMock.mockReturnValue({ stdout: '\n\n' });
    await expect(channelInfo('UC123')).rejects.toBeInstanceOf(YtdlpError);
  });

  it('throws YtdlpError when execFile fails', async () => {
    execFileMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(channelInfo('UC123')).rejects.toBeInstanceOf(YtdlpError);
  });
});

describe('videoDuration', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('returns the parsed duration', async () => {
    execFileMock.mockReturnValue({ stdout: '423\n' });
    const n = await videoDuration('abc');
    expect(n).toBe(423);
  });

  it('throws YtdlpError on NaN output', async () => {
    execFileMock.mockReturnValue({ stdout: 'NA\n' });
    await expect(videoDuration('abc')).rejects.toBeInstanceOf(YtdlpError);
  });

  it('throws YtdlpError on zero output', async () => {
    execFileMock.mockReturnValue({ stdout: '0\n' });
    await expect(videoDuration('abc')).rejects.toBeInstanceOf(YtdlpError);
  });
});
