import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep module load free of real Redis / config / notifications. The unit under test
// takes its I/O via injected deps, so the production wiring these mocks stand in
// for is never exercised here.
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./queue', () => ({
  discoveryQueue: { pause: vi.fn(), resume: vi.fn() },
  downloadQueue: { pause: vi.fn(), resume: vi.fn() },
  redis: { set: vi.fn(), del: vi.fn() },
}));
vi.mock('./config', () => ({ config: { USER_ID_STEVE: 'steve-uuid' } }));
vi.mock('./modules/notifications', () => ({ getNotifications: vi.fn() }));

import {
  shouldTripCircuit,
  tripCircuitIfNeeded,
  CIRCUIT_BREAKER_THRESHOLD,
  type CircuitBreakerDeps,
} from './circuit-breaker';

describe('shouldTripCircuit', () => {
  it('is false below the threshold', () => {
    expect(shouldTripCircuit(0)).toBe(false);
    expect(shouldTripCircuit(1)).toBe(false);
    expect(shouldTripCircuit(CIRCUIT_BREAKER_THRESHOLD - 1)).toBe(false);
  });

  it('is true at and above the threshold', () => {
    expect(shouldTripCircuit(CIRCUIT_BREAKER_THRESHOLD)).toBe(true);
    // Level keeps climbing past the ladder cap; the breaker stays tripped.
    expect(shouldTripCircuit(CIRCUIT_BREAKER_THRESHOLD + 5)).toBe(true);
  });
});

function makeDeps(overrides: Partial<CircuitBreakerDeps> = {}): CircuitBreakerDeps {
  return {
    pauseQueues: vi.fn(async () => {}),
    claimAlert: vi.fn(async () => true),
    releaseAlert: vi.fn(async () => {}),
    sendAlert: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('tripCircuitIfNeeded', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does nothing below the threshold', async () => {
    const deps = makeDeps();
    const opened = await tripCircuitIfNeeded(CIRCUIT_BREAKER_THRESHOLD - 1, deps);
    expect(opened).toBe(false);
    expect(deps.pauseQueues).not.toHaveBeenCalled();
    expect(deps.claimAlert).not.toHaveBeenCalled();
    expect(deps.sendAlert).not.toHaveBeenCalled();
  });

  it('pauses and alerts once when the winning process opens the circuit', async () => {
    const deps = makeDeps({ claimAlert: vi.fn(async () => true) });
    const opened = await tripCircuitIfNeeded(CIRCUIT_BREAKER_THRESHOLD, deps);
    expect(opened).toBe(true);
    expect(deps.pauseQueues).toHaveBeenCalledTimes(1);
    expect(deps.sendAlert).toHaveBeenCalledTimes(1);
    expect(deps.sendAlert).toHaveBeenCalledWith(CIRCUIT_BREAKER_THRESHOLD);
  });

  it('still pauses but does NOT re-alert when the flag is already set', async () => {
    // Second process (or a re-trip) — claimAlert loses the SET NX race.
    const deps = makeDeps({ claimAlert: vi.fn(async () => false) });
    const opened = await tripCircuitIfNeeded(CIRCUIT_BREAKER_THRESHOLD + 1, deps);
    expect(opened).toBe(false);
    expect(deps.pauseQueues).toHaveBeenCalledTimes(1); // pause is idempotent, always safe
    expect(deps.sendAlert).not.toHaveBeenCalled();
  });

  it('is fail-open — a throwing dependency never propagates', async () => {
    const deps = makeDeps({
      pauseQueues: vi.fn(async () => { throw new Error('redis down'); }),
    });
    await expect(tripCircuitIfNeeded(CIRCUIT_BREAKER_THRESHOLD, deps)).resolves.toBe(false);
    expect(deps.sendAlert).not.toHaveBeenCalled();
  });

  it('releases the alert claim when the send fails, so a later trip can re-alert', async () => {
    const deps = makeDeps({
      sendAlert: vi.fn(async () => { throw new Error('notify failed'); }),
    });
    await expect(tripCircuitIfNeeded(CIRCUIT_BREAKER_THRESHOLD, deps)).resolves.toBe(false);
    expect(deps.releaseAlert).toHaveBeenCalledTimes(1);

    // The retry: a later trip wins the claim again and the alert goes out.
    const retry = makeDeps({ claimAlert: vi.fn(async () => true) });
    await expect(tripCircuitIfNeeded(CIRCUIT_BREAKER_THRESHOLD + 1, retry)).resolves.toBe(true);
    expect(retry.sendAlert).toHaveBeenCalledTimes(1);
    expect(retry.releaseAlert).not.toHaveBeenCalled();
  });
});
