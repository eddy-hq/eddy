// Shared helpers for the profile-enrichment module. Per-module convention is
// to keep formula-shaped logic out of index.ts so tests can hit it without
// pulling in BullMQ / DB plumbing.

// Below this many total events (watched + dismissed) we don't trust the ratio
// enough to move trust away from the default. Brief §9a Layer 3 — prevents
// one-watch landslides on a brand-new follow.
export const TRUST_COLD_START_FLOOR = 5;

// Trust is bounded ±0.5× around 1.0 so a low-trust person isn't annihilated
// and a high-trust one doesn't dominate. 0.5 + ratio puts the formula in
// [0.5, 1.5] when ratio ∈ [0, 1]; the cold-start floor pins it to 1.0
// below the sample threshold.
export const TRUST_DEFAULT = 1.0;
export const TRUST_BASELINE = 0.5;

export function computeTrustWeight(watchedCount: number, dismissedCount: number): number {
  const total = watchedCount + dismissedCount;
  if (total < TRUST_COLD_START_FLOOR) return TRUST_DEFAULT;
  if (total === 0) return TRUST_DEFAULT;
  return TRUST_BASELINE + watchedCount / total;
}
