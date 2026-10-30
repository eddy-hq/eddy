import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GUARD_CALIBRATION_TAU through the real config schema: config.ts parses
// process.env on import, so each case sets the environment and imports it
// fresh. Placeholder values only.

const REQUIRED = {
  TOKEN_SECRET: 'x'.repeat(32),
  INTERNAL_HMAC_SECRET: 'y'.repeat(32),
  BACKUP_SSH_USER: 'placeholder',
  BACKUP_SSH_HOST: 'placeholder',
  BACKUP_DEST_PATH: '/tmp/placeholder',
  USER_ID_STEVE: '00000000-0000-7000-8000-000000000001',
  USER_ID_BOY1: '00000000-0000-7000-8000-000000000002',
  USER_ID_BOY2: '00000000-0000-7000-8000-000000000003',
};

const saved = { ...process.env };

async function loadTau(value: string | undefined): Promise<number | null> {
  vi.resetModules();
  process.env = { ...saved, ...REQUIRED };
  if (value === undefined) delete process.env['GUARD_CALIBRATION_TAU'];
  else process.env['GUARD_CALIBRATION_TAU'] = value;
  const { config } = await import('./config');
  return config.GUARD_CALIBRATION_TAU;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit);
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('GUARD_CALIBRATION_TAU', () => {
  it('defaults to 0.04 when unset', async () => {
    expect(await loadTau(undefined)).toBe(0.04);
  });

  it('takes a valid number', async () => {
    expect(await loadTau('0.1')).toBe(0.1);
    expect(await loadTau('1')).toBe(1);
  });

  it("is null for 'off'", async () => {
    expect(await loadTau('off')).toBeNull();
  });

  it('refuses 0, anything over 1 and junk at startup', async () => {
    for (const v of ['0', '1.5', 'junk']) {
      await expect(loadTau(v), v).rejects.toThrow('process.exit(1)');
    }
  });
});
