import { describe, expect, it } from 'vitest';
import { isFiveFieldCron, isTimeZone } from './config-validators';

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
