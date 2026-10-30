import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIMENSION_KEYS, LIMITS, limitsBandFor } from '../guard/rubric';
import { calibratedVerdict, calibrationReport, meetsTargets, pickTauStar, pOver, projectedUncertainRate, reliabilityBins, TAU_GRID, type CalibrationPoint, type LiveRates } from './calibrate';
import { calibrationChartHtml, writeCalibrationChart } from './calibration-chart';
import type { BlockKind, GuardVerdictLabel, HarnessItem, HarnessResult, HumanLabel, ScoreDistribution } from './util';

// The calibrated verdict and report on synthetic distributions.

const limitsFor = (ageBand: string) => LIMITS[limitsBandFor(ageBand)];

const SURE_ZERO: ScoreDistribution = [1, 0, 0, 0];

// Live candidate traffic: 5% uncertain, 90% clear-yes.
const LIVE: LiveRates = { promptVersion: 'candidate-v4.1', total: 100, uncertain: 5, clearYes: 90 };

// Every dimension certain of 0, with overrides.
function dists(over: Record<string, ScoreDistribution | null> = {}): Record<string, ScoreDistribution | null> {
  const out: Record<string, ScoreDistribution | null> = {};
  for (const k of DIMENSION_KEYS) out[k] = SURE_ZERO;
  return { ...out, ...over };
}

describe('pOver', () => {
  it('is the largest probability of any dimension scoring above its limit', () => {
    // 10-12: violence limit 1, language limit 2.
    const limits = limitsFor('10-12');
    expect(pOver(dists({ violence: [0.5, 0.3, 0.15, 0.05], language: [0.2, 0.2, 0.3, 0.3] }), limits)).toBeCloseTo(0.3, 10);
    expect(pOver(dists(), limits)).toBe(0);
  });

  it('reads the limit for the age band', () => {
    const d = dists({ sexual: [0.8, 0.2, 0, 0] });
    // Sexual: limit 0 under 10, 1 at 10-12.
    expect(pOver(d, limitsFor('under 10'))).toBeCloseTo(0.2, 10);
    expect(pOver(d, limitsFor('10-12'))).toBe(0);
    // An unknown band is the most restrictive.
    expect(pOver(d, limitsFor('unknown'))).toBeCloseTo(0.2, 10);
  });

  it('is null when any dimension is unread or missing, or there are no distributions', () => {
    const limits = limitsFor('10-12');
    expect(pOver(dists({ attitude: null }), limits)).toBeNull();
    const missing = dists();
    delete missing['commercial'];
    expect(pOver(missing, limits)).toBeNull();
    expect(pOver(undefined, limits)).toBeNull();
  });
});

describe('calibratedVerdict', () => {
  const limits = limitsFor('10-12');
  const d = dists({ dangerous: [0.6, 0.3, 0.1, 0] }); // p_over 0.1

  it('keeps clear_yes only when p_over is below τ', () => {
    expect(calibratedVerdict('clear_yes', d, limits, 0.2)).toBe('clear_yes');
    expect(calibratedVerdict('clear_yes', d, limits, 0.1)).toBe('uncertain');
    expect(calibratedVerdict('clear_yes', d, limits, 0.05)).toBe('uncertain');
  });

  it('fails closed on an unread dimension', () => {
    expect(calibratedVerdict('clear_yes', dists({ language: null }), limits, 0.99)).toBe('uncertain');
    expect(calibratedVerdict('clear_yes', undefined, limits, 0.99)).toBe('uncertain');
  });

  it('never loosens', () => {
    for (const plain of ['clear_no', 'uncertain'] as const) {
      for (const tau of [0, 0.01, 0.5, 1, 2]) {
        expect(calibratedVerdict(plain, dists(), limits, tau)).toBe(plain);
        expect(calibratedVerdict(plain, undefined, limits, tau)).toBe(plain);
      }
    }
  });
});

function item(id: string, label: HumanLabel, blockKind: BlockKind | null, holdout = false): HarnessItem {
  return {
    itemId: id, subjectType: 'candidate', subjectId: `c-${id}`, userId: 'kid_1', label,
    firstPassLabel: label, revisedAt: null, blockKind, decisionSource: 'spot_check', rubricVersion: 'rubric-v1.3',
    guardVerdict: 'clear_yes', livePromptVersion: 'candidate-v4.1', inputs: 'original',
    decidedAt: '2026-09-20T12:00:00.000Z', holdout, ageBand: '10-12',
    title: 'Placeholder title', channel: 'Placeholder channel', description: null, tags: [], categoryId: null,
    madeForKids: null, ageRestricted: false, channelHistory: null,
  };
}

function result(adapterId: string, itemId: string, verdict: GuardVerdictLabel, pDangerOver?: number | null): HarnessResult {
  const distributions = pDangerOver === undefined
    ? undefined
    : pDangerOver === null
      ? dists({ dangerous: null })
      : dists({ dangerous: [1 - pDangerOver, 0, pDangerOver, 0] });
  return {
    adapterId, itemId, verdict, durationMs: 1, evaluatedAt: '2026-10-02T08:00:00.000Z',
    ...(distributions ? { distributions } : {}),
  };
}

// A synthetic set: on non-holdout, 20 Allowed clear_yes with p_over 0.01,
// 2 Unsafe clear_yes with p_over 0.3, 4 Unsafe clear_no, 4 Allowed uncertain.
// On holdout, 5 Allowed clear_yes at 0.01 and 1 Unsafe clear_yes at 0.3.
function scenario() {
  const items: HarnessItem[] = [];
  const results: HarnessResult[] = [];
  const add = (id: string, label: HumanLabel, kind: BlockKind | null, holdout: boolean, verdict: GuardVerdictLabel, p: number | null) => {
    items.push(item(id, label, kind, holdout));
    results.push(result('logprob', id, verdict, p));
    results.push(result('incumbent', id, verdict));
  };
  for (let i = 0; i < 20; i++) add(`a${i}`, 'clear_yes', null, false, 'clear_yes', 0.01);
  for (let i = 0; i < 2; i++) add(`u${i}`, 'clear_no', 'unsafe', false, 'clear_yes', 0.3);
  for (let i = 0; i < 4; i++) add(`n${i}`, 'clear_no', 'unsafe', false, 'clear_no', 0.9);
  for (let i = 0; i < 4; i++) add(`q${i}`, 'clear_yes', null, false, 'uncertain', 0.5);
  for (let i = 0; i < 5; i++) add(`ha${i}`, 'clear_yes', null, true, 'clear_yes', 0.01);
  add('hu0', 'clear_no', 'unsafe', true, 'clear_yes', 0.3);
  // Left out of the safety metrics.
  add('nfu', 'clear_no', 'not_for_us', false, 'clear_yes', 0.01);
  add('unrec', 'clear_no', null, false, 'clear_yes', 0.01);
  // An item only the logprob adapter has, with an unread dimension.
  items.push(item('only', 'clear_yes', null, false));
  results.push(result('logprob', 'only', 'clear_yes', null));
  // Not scored by the logprob adapter at all.
  items.push(item('unscored', 'clear_yes', null, false));
  return { items, results };
}

describe('calibrationReport', () => {
  const { items, results } = scenario();
  // A 30% cap here, which every τ is under.
  const r = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: 'incumbent', limitsFor, uncertainCap: 0.3, live: LIVE });

  it('scores safety labels only, by split', () => {
    expect(r.datasetItems).toBe(items.length);
    expect(r.scored).toBe(items.length - 1);
    expect(r.excluded).toEqual({ notForUs: 1, unrecorded: 1 });
    expect(r.nonHoldoutItems).toBe(31);
    expect(r.holdoutItems).toBe(6);
    expect(r.clearYesWithoutPOver).toEqual({ nonHoldout: 1, holdout: 0 });
  });

  it('reports the plain verdicts and the incumbent on the items it covers', () => {
    expect(r.plain.nonHoldout.matrix.clear_yes).toEqual({ clear_yes: 21, clear_no: 2 });
    expect(r.plain.nonHoldout.unsafePassed).toBe(2);
    expect(r.plain.nonHoldout.unsafeTotal).toBe(6);
    expect(r.baseline!.covered).toBe(36);
    expect(r.baseline!.of).toBe(37);
    expect(r.baseline!.nonHoldout.matrix.clear_yes).toEqual({ clear_yes: 20, clear_no: 2 });
    expect(r.baseline!.holdout.matrix.clear_yes).toEqual({ clear_yes: 5, clear_no: 1 });
  });

  it('sweeps τ on non-holdout, tightening only', () => {
    expect(r.sweep.map((p) => p.tau)).toEqual(TAU_GRID);
    const low = r.sweep.find((p) => p.tau === 0.2)!;
    // Unsafe at 0.3 escalated; the unread item escalated too.
    expect(low.matrix.clear_yes).toEqual({ clear_yes: 20, clear_no: 0 });
    expect(low.matrix.uncertain).toEqual({ clear_yes: 5, clear_no: 2 });
    expect(low.unsafePassed).toBe(0);
    const high = r.sweep.find((p) => p.tau === 0.4)!;
    expect(high.matrix.clear_yes).toEqual({ clear_yes: 20, clear_no: 2 });
    // Clear-no never moves.
    for (const p of r.sweep) expect(p.matrix.clear_no).toEqual(r.plain.nonHoldout.matrix.clear_no);
  });

  it('picks the loosest τ with the fewest Unsafe passed under the cap, and tests it once on holdout', () => {
    // τ <= 0.3 escalates the Unsafe pair (0 passed, uncertain 7/31); above
    // 0.3 they pass. The ties at 0 resolve to the loosest, 0.3.
    expect(r.uncertainCap).toBe(0.3);
    expect(r.minUnsafePassed).toBe(0);
    expect(r.tauStar).toBe(0.3);
    expect(meetsTargets(r.sweep.find((p) => p.tau === 0.3)!)).toEqual({ clearYesPrecision: true, uncertainRate: true });
    expect(meetsTargets(r.sweep.find((p) => p.tau === 0.4)!)).toEqual({ clearYesPrecision: false, uncertainRate: true });
    expect(r.holdoutAtTauStar!.tau).toBe(0.3);
    expect(r.holdoutAtTauStar!.matrix.clear_yes).toEqual({ clear_yes: 5, clear_no: 0 });
    expect(r.holdoutAtTauStar!.unsafePassed).toBe(0);
  });

  it('projects the live uncertain rate from the audited clear-yes items, whatever their label', () => {
    // Audited: the 25 non-holdout items replayed clear_yes with a live clear_yes
    // (20 Allowed, 2 Unsafe, Not for us, unrecorded, unread). τ <= 0.3
    // escalates 3 of them (the Unsafe pair and the unread), 0.4 and up 1.
    expect(r.auditedClearYes).toBe(25);
    expect(r.live).toEqual(LIVE);
    expect(r.sweep.find((p) => p.tau === 0.3)!.projectedUncertainRate).toBeCloseTo(0.05 + 0.9 * (3 / 25), 10);
    expect(r.sweep.find((p) => p.tau === 0.4)!.projectedUncertainRate).toBeCloseTo(0.05 + 0.9 * (1 / 25), 10);
    // Off the sweep there is nothing to project.
    expect(r.plain.nonHoldout.projectedUncertainRate).toBeNull();
    expect(r.holdoutAtTauStar!.projectedUncertainRate).toBeNull();
  });

  it('applies the default 20% cap to the projected live rate, not the labelled rate', () => {
    // τ <= 0.3 costs 7/31 = 22.6% of the labelled items, over the cap, but a
    // projected 15.8% live: still eligible, and it passes no Unsafe.
    const d = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: null, limitsFor, live: LIVE });
    expect(d.uncertainCap).toBe(0.2);
    expect(d.sweep.find((p) => p.tau === 0.3)!.metrics.uncertainRate!).toBeGreaterThan(0.2);
    expect(d.minUnsafePassed).toBe(0);
    expect(d.tauStar).toBe(0.3);
  });

  it('says when no τ is under the cap', () => {
    // The loosest τ still projects 8.6%.
    const none = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: null, limitsFor, uncertainCap: 0.05, live: LIVE });
    expect(none.minUnsafePassed).toBeNull();
    expect(none.tauStar).toBeNull();
    expect(none.holdoutAtTauStar).toBeNull();
    expect(none.baseline).toBeNull();
  });

  it('counts only audits from the live prompt version being projected', () => {
    // Two extra audits that would escalate at every τ: one from a request's
    // transcript pass, one with no recorded prompt. Neither counts.
    const extraItems = [...items];
    const extraResults = [...results];
    for (const [id, version] of [['tx', 'candidate-transcript-v4.1'], ['unk', null]] as const) {
      extraItems.push({ ...item(id, 'clear_yes', null), livePromptVersion: version });
      extraResults.push(result('logprob', id, 'clear_yes', 0.9));
    }
    const mixed = calibrationReport({ items: extraItems, results: extraResults, adapterId: 'logprob', baselineAdapterId: null, limitsFor, live: LIVE });
    expect(mixed.auditedClearYes).toBe(25);
    expect(mixed.sweep.map((p) => p.projectedUncertainRate)).toEqual(r.sweep.map((p) => p.projectedUncertainRate));
    expect(mixed.tauStar).toBe(calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: null, limitsFor, live: LIVE }).tauStar);
  });

  it('has no τ* when no audit matches the live prompt version', () => {
    const other = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: null, limitsFor, live: { ...LIVE, promptVersion: 'candidate-v5' } });
    expect(other.auditedClearYes).toBe(0);
    expect(other.sweep.every((p) => p.projectedUncertainRate === null)).toBe(true);
    expect(other.tauStar).toBeNull();
  });

  it('has no τ* with no live rates to project from', () => {
    const blind = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: null, limitsFor, live: null });
    expect(blind.sweep.every((p) => p.projectedUncertainRate === null)).toBe(true);
    expect(blind.tauStar).toBeNull();
  });

  it('bins non-holdout clear_yes items by p_over', () => {
    const byLow = new Map(r.reliability.map((b) => [b.low, b]));
    expect(byLow.get(0.01)).toMatchObject({ n: 20, unsafe: 0, rate: 0 });
    expect(byLow.get(0.3)).toMatchObject({ n: 2, unsafe: 2, rate: 1 });
    expect(byLow.get(0.3)!.meanPOver).toBeCloseTo(0.3, 10);
    // The unread item is in no bin; total binned is the clear_yes count less it.
    expect(r.reliability.reduce((s, b) => s + b.n, 0)).toBe(22);
  });
});

// The shape of the first household run (non-holdout): Unsafe passed 6 at
// τ 0.02–0.04 with labelled uncertain over 20%, 7 at 0.05–0.15 under it, then
// 8, 9, 10 as τ loosens. With the cap on the labelled rate the rule picked
// 0.15; on the projected live rate, 0.02–0.04 project about 10.7%.
function householdShape() {
  const items: HarnessItem[] = [];
  const results: HarnessResult[] = [];
  let n = 0;
  const add = (label: HumanLabel, kind: BlockKind | null, verdict: GuardVerdictLabel, p: number, count: number, holdout = false) => {
    for (let i = 0; i < count; i++) {
      const id = `s${n++}`;
      items.push(item(id, label, kind, holdout));
      results.push(result('logprob', id, verdict, p));
      results.push(result('incumbent', id, verdict));
    }
  };
  // Unsafe the plain verdict passes, by p_over: six never caught, then one
  // each released at τ 0.05, 0.2, 0.4 and 0.5.
  add('clear_no', 'unsafe', 'clear_yes', 0.01, 6);
  for (const p of [0.04, 0.15, 0.3, 0.4]) add('clear_no', 'unsafe', 'clear_yes', p, 1);
  // Allowed: 200 cleanly cleared, 10 escalated at τ <= 0.04, 0.1 and 0.5, and
  // 40 the plain verdict already leaves uncertain. 260 items in all, so
  // uncertain is 54/260 (20.8%) at τ 0.04 and 48/260 (18.5%) at 0.05.
  add('clear_yes', null, 'clear_yes', 0.01, 200);
  add('clear_yes', null, 'clear_yes', 0.04, 5);
  add('clear_yes', null, 'clear_yes', 0.1, 3);
  add('clear_yes', null, 'clear_yes', 0.5, 2);
  add('clear_yes', null, 'uncertain', 0.5, 40);
  // Holdout: one Unsafe at 0.15 the incumbent passes and τ* = 0.15 catches.
  add('clear_yes', null, 'clear_yes', 0.01, 9, true);
  add('clear_no', 'unsafe', 'clear_yes', 0.15, 1, true);
  return { items, results };
}

describe('τ* selection', () => {
  const { items, results } = householdShape();
  const r = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: 'incumbent', limitsFor, live: LIVE });
  // A 10% cap, which 0.02–0.04 project over.
  const tight = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: 'incumbent', limitsFor, live: LIVE, uncertainCap: 0.1 });
  const at = (tau: number) => r.sweep.find((p) => p.tau === tau)!;

  it('reproduces the household sweep shape', () => {
    expect(r.sweep.map((p) => p.unsafePassed)).toEqual([6, 6, 6, 7, 7, 7, 7, 7, 7, 8, 8, 8, 9, 10]);
    for (const tau of [0.02, 0.03, 0.04]) expect(at(tau).metrics.uncertainRate!).toBeGreaterThan(0.2);
    for (const tau of [0.05, 0.06, 0.08, 0.1, 0.12, 0.15]) expect(at(tau).metrics.uncertainRate!).toBeLessThanOrEqual(0.2);
    expect(at(0.04).metrics.uncertainRate).toBeCloseTo(54 / 260, 10);
    expect(at(0.05).metrics.uncertainRate).toBeCloseTo(48 / 260, 10);
    // The incumbent meets the precision target already (210/220), so the
    // old "loosest τ meeting the targets" rule would have picked 0.5.
    expect(meetsTargets(r.baseline!.nonHoldout).clearYesPrecision).toBe(true);
  });

  it('keeps a τ whose labelled rate is over the 20% cap when its projected live rate is under it', () => {
    // 220 audited clear-yes items; τ 0.04 escalates 14 of them.
    expect(at(0.04).projectedUncertainRate).toBeCloseTo(0.05 + 0.9 * (14 / 220), 10);
    expect(r.uncertainCap).toBe(0.2);
    expect(r.minUnsafePassed).toBe(6);
    expect(r.tauStar).toBe(0.04);
  });

  it('picks the loosest τ with the fewest Unsafe passed under a tighter cap', () => {
    expect(tight.sweep.find((p) => p.tau === 0.05)!.projectedUncertainRate).toBeCloseTo(0.05 + 0.9 * (8 / 220), 10);
    expect(tight.minUnsafePassed).toBe(7);
    expect(tight.tauStar).toBe(0.15);
  });

  it('tests τ* once on holdout, beside the incumbent there', () => {
    expect(tight.holdoutAtTauStar!.tau).toBe(0.15);
    expect(tight.holdoutAtTauStar!.unsafePassed).toBe(0);
    expect(tight.baseline!.holdout.unsafePassed).toBe(1);
  });

  it('reports no τ* when no τ meets the cap', () => {
    const none = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: 'incumbent', limitsFor, uncertainCap: 0.05, live: LIVE });
    expect(none.tauStar).toBeNull();
    expect(none.minUnsafePassed).toBeNull();
    expect(none.holdoutAtTauStar).toBeNull();
  });
});

describe('pickTauStar', () => {
  const pt = (tau: number, unsafePassed: number, projected: number | null): CalibrationPoint =>
    ({ tau, unsafePassed, projectedUncertainRate: projected, metrics: { uncertainRate: 0.99 } }) as unknown as CalibrationPoint;

  it('resolves ties at the minimum to the loosest τ, wherever they sit in the sweep', () => {
    const sweep = [pt(0.3, 2, 0.1), pt(0.1, 2, 0.15), pt(0.2, 2, 0.12), pt(0.4, 3, 0.05)];
    expect(pickTauStar(sweep, 0.2)).toEqual({ tauStar: 0.3, minUnsafePassed: 2 });
  });

  it('counts a τ exactly at the cap and ignores one over it or with no rate', () => {
    const sweep = [pt(0.02, 0, 0.21), pt(0.05, 1, 0.2), pt(0.1, 0, null), pt(0.2, 4, 0.1)];
    expect(pickTauStar(sweep, 0.2)).toEqual({ tauStar: 0.05, minUnsafePassed: 1 });
  });

  it('is empty when nothing is under the cap', () => {
    expect(pickTauStar([pt(0.1, 0, 0.5)], 0.2)).toEqual({ tauStar: null, minUnsafePassed: null });
  });
});

describe('projectedUncertainRate', () => {
  it('adds the live clear-yes share τ escalates to the live uncertain share, failing closed on unread', () => {
    // 4 audited: one unread, one at 0.3, two at 0.01. τ 0.2 escalates 2 of 4.
    expect(projectedUncertainRate(LIVE, [null, 0.3, 0.01, 0.01], 0.2)).toBeCloseTo(0.05 + 0.9 * 0.5, 10);
    expect(projectedUncertainRate(LIVE, [0.01, 0.01], 0.2)).toBeCloseTo(0.05, 10);
  });

  it('is null with nothing to project from', () => {
    expect(projectedUncertainRate(null, [0.01], 0.2)).toBeNull();
    expect(projectedUncertainRate({ ...LIVE, total: 0, uncertain: 0, clearYes: 0 }, [0.01], 0.2)).toBeNull();
    expect(projectedUncertainRate(LIVE, [], 0.2)).toBeNull();
  });
});

describe('reliabilityBins', () => {
  it('closes the last bin at 1', () => {
    const row = (p: number) => ({ itemId: 'x', holdout: false, label: 'clear_no' as const, plain: 'clear_yes' as const, pOver: p });
    const bins = reliabilityBins([row(0), row(0.5), row(1)], [0, 0.5, 1]);
    expect(bins.map((b) => b.n)).toEqual([1, 2]);
  });
});

describe('calibration chart', () => {
  const { items, results } = scenario();
  const r = calibrationReport({ items, results, adapterId: 'logprob', baselineAdapterId: 'incumbent', limitsFor, uncertainCap: 0.3, live: LIVE });
  const html = calibrationChartHtml(r, 'dataset-2026-10-02.jsonl', new Date('2026-10-18T19:00:00Z'));

  it('is self-contained HTML with the three charts and aggregates only', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.match(/<svg /g)).toHaveLength(3);
    expect(html).toContain('τ* = 0.3');
    // The rule in words, and the cap line it was picked under.
    expect(html).toContain('Rule (pre-registered, non-holdout only)');
    expect(html).toContain('cap 30% (picks τ*)');
    expect(html).toContain('Projected live uncertain rate against τ');
    expect(html).not.toMatch(/<script|https?:\/\/|src=/);
    // No item content or ids.
    expect(html).not.toContain('Placeholder');
    expect(html).not.toMatch(/\b(a1|hu0|unrec|kid_1)\b/);
  });

  it('widens the precision axis to a holdout result outside the non-holdout range rather than clamping it', () => {
    const holdout = r.holdoutAtTauStar!;
    const worse = {
      ...r,
      holdoutAtTauStar: { ...holdout, metrics: { ...holdout.metrics, clearYesPrecision: 0, uncertainRate: 0.9 } },
    };
    const out = calibrationChartHtml(worse, 'dataset-2026-10-02.jsonl', new Date('2026-10-18T19:00:00Z'));
    // One holdout diamond, on the precision chart: the uncertain chart plots
    // the projected live rate, which the holdout's labelled rate isn't.
    const ys = [...out.matchAll(/width="10" height="10" fill="#c43d4b" transform="rotate\(45 [\d.]+ ([\d.]+)\)"/g)].map((m) => Number(m[1]));
    const plotHeight = 300 - 52 - 62;
    // 0% precision sits on the axis floor (now 0%).
    expect(ys).toEqual([plotHeight]);
    expect(out).toContain('>0%</text>');
  });

  it('is written mode 0600, even over an existing file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-calibration-'));
    try {
      const file = path.join(dir, 'calibration-dataset-2026-10-02.html');
      writeFileSync(file, 'old', { mode: 0o644 });
      writeCalibrationChart(file, html);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, 'utf8')).toBe(html);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
