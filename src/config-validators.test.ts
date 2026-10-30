import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARD_CALIBRATION_TAU, isFiveFieldCron, isTimeZone, parseCalibrationTau } from './config-validators';

describe('isFiveFieldCron', () => {
  it('accepts ordinary five-field patterns', () => {
    for (const p of ['0 19 * * *', '30 18 * * 1-5', '*/15 * * * *', '0  19 * * *']) {
      expect(isFiveFieldCron(p), p).toBe(true);
    }
  });

  it('refuses out-of-range values', () => {
    for (const p of ['0 25 * * *', '60 19 * * *', '0 19 32 * *', '0 19 * 13 *', '0 19 * * 8']) {
      expect(isFiveFieldCron(p), p).toBe(false);
    }
  });

  it('refuses bad syntax and the wrong number of fields', () => {
    for (const p of ['nonsense x y z w', '0 19 * *', '0 0 19 * * *', '', '0 19 * * * extra']) {
      expect(isFiveFieldCron(p), p).toBe(false);
    }
  });
});

describe('isTimeZone', () => {
  it('accepts IANA zones and refuses anything else', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('parseCalibrationTau', () => {
  it('defaults to 0.04 when unset or blank', () => {
    expect(DEFAULT_GUARD_CALIBRATION_TAU).toBe(0.04);
    expect(parseCalibrationTau(undefined)).toBe(0.04);
    expect(parseCalibrationTau('')).toBe(0.04);
    expect(parseCalibrationTau('  ')).toBe(0.04);
  });

  it('accepts a number in (0, 1]', () => {
    expect(parseCalibrationTau('0.04')).toBe(0.04);
    expect(parseCalibrationTau(' 0.3 ')).toBe(0.3);
    expect(parseCalibrationTau('1')).toBe(1);
    expect(parseCalibrationTau('1e-3')).toBe(0.001);
  });

  it("is null for 'off'", () => {
    expect(parseCalibrationTau('off')).toBeNull();
  });

  it('refuses 0, negatives, anything over 1 and junk', () => {
    for (const v of ['0', '0.0', '-0.1', '1.01', '4', 'Infinity', 'NaN', 'abc', '0.04abc', '4%', 'OFF', 'none', 'false']) {
      expect(parseCalibrationTau(v), v).toBeUndefined();
    }
  });
});
