import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  config: { YTDLP_BIN_M4: '/fake/yt-dlp', NODE_ENV: 'test', PERSON_CHANNEL_INFO_TTL_DAYS: 30 },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ytdlp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ytdlp')>()),
  channelInfo: vi.fn(),
}));

const { getMock, runMock, prepareSpy } = vi.hoisted(() => {
  const getMock = vi.fn();
  const runMock = vi.fn();
  const prepareSpy = vi.fn(() => ({ get: getMock, run: runMock }));
  return { getMock, runMock, prepareSpy };
});

vi.mock('../../db/client', () => ({
  db: { prepare: prepareSpy },
}));

import { channelInfo, YtdlpError } from '../../ytdlp';
import { config } from '../../config';
import { applyChannelInfoToPerson } from './applyChannelInfo';

const BIO_PHOTO_UPDATE =
  'UPDATE people SET bio = COALESCE(?, bio), photo_url = COALESCE(?, photo_url), channel_info_fetched_at = ? WHERE person_id = ?';
const STAMP_ONLY_UPDATE = 'UPDATE people SET channel_info_fetched_at = ? WHERE person_id = ?';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(() => {
  runMock.mockReset();
  getMock.mockReset();
  prepareSpy.mockClear();
  vi.mocked(channelInfo).mockReset();
  // Default: no row / never fetched → treated as stale → fetch proceeds.
  getMock.mockReturnValue(undefined);
  config.PERSON_CHANNEL_INFO_TTL_DAYS = 30;
});

describe('applyChannelInfoToPerson — staleness gate (#185)', () => {
  it('skips the yt-dlp fetch entirely when the last refresh is within the TTL', async () => {
    getMock.mockReturnValue({ channel_info_fetched_at: new Date().toISOString() });

    await applyChannelInfoToPerson('person-fresh', 'UCfresh');

    expect(channelInfo).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    // Only the staleness SELECT was prepared.
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy).toHaveBeenCalledWith(
      'SELECT channel_info_fetched_at FROM people WHERE person_id = ?',
    );
  });

  it('fetches when the last refresh is older than the TTL', async () => {
    getMock.mockReturnValue({ channel_info_fetched_at: '2000-01-01T00:00:00.000Z' });
    vi.mocked(channelInfo).mockResolvedValue({ description: 'Lego builds.', avatarUrl: 'http://a' });

    await applyChannelInfoToPerson('person-stale', 'UCstale');

    expect(channelInfo).toHaveBeenCalledWith('UCstale');
  });

  it('treats a never-fetched person (no timestamp) as stale and fetches', async () => {
    getMock.mockReturnValue({ channel_info_fetched_at: null });
    vi.mocked(channelInfo).mockResolvedValue({ description: 'Lego builds.', avatarUrl: 'http://a' });

    await applyChannelInfoToPerson('person-new', 'UCnew');

    expect(channelInfo).toHaveBeenCalledWith('UCnew');
  });

  it('treats a malformed timestamp as stale rather than fresh-forever', async () => {
    getMock.mockReturnValue({ channel_info_fetched_at: 'not-a-date' });
    vi.mocked(channelInfo).mockResolvedValue({ description: 'Lego builds.', avatarUrl: 'http://a' });

    await applyChannelInfoToPerson('person-bad', 'UCbad');

    expect(channelInfo).toHaveBeenCalledWith('UCbad');
  });

  it('disables the gate when TTL is 0 — always fetches, no staleness SELECT', async () => {
    config.PERSON_CHANNEL_INFO_TTL_DAYS = 0;
    vi.mocked(channelInfo).mockResolvedValue({ description: 'Lego builds.', avatarUrl: 'http://a' });

    await applyChannelInfoToPerson('person-anyttl', 'UCanyttl');

    expect(channelInfo).toHaveBeenCalledWith('UCanyttl');
    expect(prepareSpy).not.toHaveBeenCalledWith(
      'SELECT channel_info_fetched_at FROM people WHERE person_id = ?',
    );
  });
});

describe('applyChannelInfoToPerson — apply + stamp', () => {
  it('captures bio + photo and stamps the fetch time (clean description, has avatar)', async () => {
    vi.mocked(channelInfo).mockResolvedValue({
      description: 'A channel about Lego builds. New videos weekly.',
      avatarUrl: 'http://avatar',
    });

    await applyChannelInfoToPerson('person-1', 'UC123');

    expect(channelInfo).toHaveBeenCalledWith('UC123');
    expect(prepareSpy).toHaveBeenCalledWith(BIO_PHOTO_UPDATE);
    expect(runMock).toHaveBeenCalledWith(
      'A channel about Lego builds.',
      'http://avatar',
      expect.stringMatching(ISO),
      'person-1',
    );
  });

  it('refreshes on poll: passes null bio when description is promotional, preserving prior value via COALESCE', async () => {
    vi.mocked(channelInfo).mockResolvedValue({
      description: 'SUBSCRIBE for daily uploads 🔔',
      avatarUrl: 'http://avatar-v2',
    });

    await applyChannelInfoToPerson('person-2', 'UC456');

    expect(runMock).toHaveBeenCalledWith(null, 'http://avatar-v2', expect.stringMatching(ISO), 'person-2');
  });

  it('still updates photo_url when description is missing entirely', async () => {
    vi.mocked(channelInfo).mockResolvedValue({
      description: null,
      avatarUrl: 'http://avatar',
    });

    await applyChannelInfoToPerson('person-3', 'UC789');

    expect(runMock).toHaveBeenCalledWith(null, 'http://avatar', expect.stringMatching(ISO), 'person-3');
  });

  it('swallows yt-dlp failures silently and does not touch the row (so it retries next pass)', async () => {
    vi.mocked(channelInfo).mockRejectedValue(new YtdlpError('spawn failed'));

    await expect(applyChannelInfoToPerson('person-4', 'UC000')).resolves.toBeUndefined();

    expect(runMock).not.toHaveBeenCalled();
  });

  it('stamps the fetch time but skips the bio/photo write when both are null (no-op data)', async () => {
    vi.mocked(channelInfo).mockResolvedValue({
      description: 'SUBSCRIBE for daily uploads',
      avatarUrl: null,
    });

    await applyChannelInfoToPerson('person-5', 'UC111');

    // The timestamp must advance so a bio-less channel doesn't re-fetch every pass...
    expect(prepareSpy).toHaveBeenCalledWith(STAMP_ONLY_UPDATE);
    expect(runMock).toHaveBeenCalledWith(expect.stringMatching(ISO), 'person-5');
    // ...but the bio/photo columns are left untouched.
    expect(prepareSpy).not.toHaveBeenCalledWith(BIO_PHOTO_UPDATE);
  });
});
