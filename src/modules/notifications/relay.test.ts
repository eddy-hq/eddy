import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../../logger';
import { createRelayNotifications, parseRelayPayload, RELAY_PATH } from './relay';

const RECIPIENT = '01890a5d-ac96-774b-bcce-b302099a8057';

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('createRelayNotifications (worker side)', () => {
  it('posts a circuit_open alert to the M4 over the signed channel', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    await createRelayNotifications(post).notify({ kind: 'circuit_open', consecutiveTrips: 2 }, RECIPIENT);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(RELAY_PATH);
    expect(post.mock.calls[0]?.[1]).toEqual({
      event: { kind: 'circuit_open', consecutiveTrips: 2 },
      recipient: RECIPIENT,
    });
  });

  it('logs the alert locally even when the M4 cannot be reached, and does not throw', async () => {
    const post = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(
      createRelayNotifications(post).notify(
        { kind: 'download_failure_streak', consecutiveFailures: 5, lastError: 'HTTP Error 403: Forbidden' },
        RECIPIENT,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'download_failure_streak' }),
      'Notification relay to the M4 failed; logged only',
    );
  });

  it('never relays a user-facing kind', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    await createRelayNotifications(post).notify(
      { kind: 'video_ready', requestId: 'r1', title: 'A title that must stay put' },
      RECIPIENT,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe('parseRelayPayload (M4 side)', () => {
  it('accepts the two ops kinds the worker raises', () => {
    expect(parseRelayPayload({ event: { kind: 'circuit_open', consecutiveTrips: 1 }, recipient: RECIPIENT })).not.toBeNull();
    expect(parseRelayPayload({
      event: { kind: 'download_failure_streak', consecutiveFailures: 3, lastError: 'x' },
      recipient: RECIPIENT,
    })).not.toBeNull();
  });

  it('rejects user-facing kinds, extra fields, a non-UUID recipient and junk', () => {
    expect(parseRelayPayload({ event: { kind: 'video_ready', requestId: 'r1', title: 't' }, recipient: RECIPIENT })).toBeNull();
    expect(parseRelayPayload({ event: { kind: 'parent_review', requestId: 'r1' }, recipient: RECIPIENT })).toBeNull();
    expect(parseRelayPayload({ event: { kind: 'circuit_open', consecutiveTrips: 1, title: 'smuggled' }, recipient: RECIPIENT })).toBeNull();
    expect(parseRelayPayload({ event: { kind: 'circuit_open', consecutiveTrips: 1 }, recipient: 'Boy1' })).toBeNull();
    expect(parseRelayPayload(null)).toBeNull();
    expect(parseRelayPayload('circuit_open')).toBeNull();
  });
});
