import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  config: { YTDLP_BIN_M4: '/fake/yt-dlp', NODE_ENV: 'test' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ytdlp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ytdlp')>()),
  channelInfo: vi.fn(),
}));

const { updateRun, prepareSpy } = vi.hoisted(() => {
  const updateRun = vi.fn();
  const prepareSpy = vi.fn(() => ({ run: updateRun }));
  return { updateRun, prepareSpy };
});

vi.mock('../../db/client', () => ({
  db: { prepare: prepareSpy },
}));

import { channelInfo, YtdlpError } from '../../ytdlp';
import { applyChannelInfoToPerson } from './applyChannelInfo';

beforeEach(() => {
  updateRun.mockReset();
  prepareSpy.mockClear();
  vi.mocked(channelInfo).mockReset();
});

describe('applyChannelInfoToPerson', () => {
  it('captures bio + photo on follow (clean description, has avatar)', async () => {
    vi.mocked(channelInfo).mockResolvedValue({
      description: 'A channel about Lego builds. New videos weekly.',
      avatarUrl: 'http://avatar',
    });

    await applyChannelInfoToPerson('person-1', 'UC123');

    expect(channelInfo).toHaveBeenCalledWith('UC123');
    expect(prepareSpy).toHaveBeenCalledWith(
      'UPDATE people SET bio = COALESCE(?, bio), photo_url = COALESCE(?, photo_url) WHERE person_id = ?',
    );
    expect(updateRun).toHaveBeenCalledWith(
      'A channel about Lego builds.',
      'http://avatar',
      'person-1',
    );
  });

  it('refreshes on poll: passes null bio when description is promotional, preserving prior value via COALESCE', async () => {
    vi.mocked(channelInfo).mockResolvedValue({
      description: 'SUBSCRIBE for daily uploads 🔔',
      avatarUrl: 'http://avatar-v2',
    });

    await applyChannelInfoToPerson('person-2', 'UC456');

    expect(updateRun).toHaveBeenCalledWith(null, 'http://avatar-v2', 'person-2');
  });

  it('still updates photo_url when description is missing entirely', async () => {
    vi.mocked(channelInfo).mockResolvedValue({
      description: null,
      avatarUrl: 'http://avatar',
    });

    await applyChannelInfoToPerson('person-3', 'UC789');

    expect(updateRun).toHaveBeenCalledWith(null, 'http://avatar', 'person-3');
  });

  it('swallows yt-dlp failures silently and does not touch the row', async () => {
    vi.mocked(channelInfo).mockRejectedValue(new YtdlpError('spawn failed'));

    await expect(applyChannelInfoToPerson('person-4', 'UC000')).resolves.toBeUndefined();

    expect(updateRun).not.toHaveBeenCalled();
  });
});
