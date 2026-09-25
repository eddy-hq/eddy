import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIMENSIONS,
  DIMENSION_KEYS,
  FLAGS,
  FLAG_KEYS,
  FLAG_REQUEST_ACTIONS,
  HARD_STOPS,
  HARD_STOP_KEYS,
  LIMITS,
  LIMITS_BANDS,
  RUBRIC_VERSION,
  describeDriver,
  driverCountKey,
  limitsBandFor,
  verdictFromScores,
  type HardStop,
  type HardStopLevel,
  type LimitsBand,
  type RubricDimension,
  type RubricFlag,
  type RubricScore,
  type RubricScores,
  type RubricVerdict,
} from './rubric';

function scores(over: {
  dimensions?: Partial<Record<RubricDimension, RubricScore>>;
  hardStops?: Partial<Record<HardStop, HardStopLevel>>;
  flags?: Partial<Record<RubricFlag, boolean>>;
} = {}): RubricScores {
  return {
    dimensions: {
      ...Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 0])) as Record<RubricDimension, RubricScore>,
      ...over.dimensions,
    },
    hardStops: {
      ...Object.fromEntries(HARD_STOP_KEYS.map((k) => [k, 'none'])) as Record<HardStop, HardStopLevel>,
      ...over.hardStops,
    },
    flags: {
      ...Object.fromEntries(FLAG_KEYS.map((k) => [k, false])) as Record<RubricFlag, boolean>,
      ...over.flags,
    },
  };
}

// Every age band string users.getAgeBand produces, plus unknowns, and the
// limits band each must use.
const AGE_BANDS: Array<[string | null | undefined, LimitsBand]> = [
  ['under 10', 'under 10'],
  ['10-12', '10-12'],
  ['13-15', '13-15'],
  ['16-17', '13-15'],
  ['18+', '13-15'],
  [null, 'under 10'],
  [undefined, 'under 10'],
  ['', 'under 10'],
  ['adult', 'under 10'],
];

describe('rubric shape', () => {
  it('is rubric-v1 with 8 dimensions, 4 hard stops and 2 flags, each dimension with 4 anchors', () => {
    expect(RUBRIC_VERSION).toBe('rubric-v1.2');
    expect(DIMENSIONS.map((d) => d.key)).toEqual([...DIMENSION_KEYS]);
    expect(HARD_STOPS.map((h) => h.key)).toEqual([...HARD_STOP_KEYS]);
    expect(FLAGS.map((f) => f.key)).toEqual([...FLAG_KEYS]);
    for (const d of DIMENSIONS) {
      expect(d.anchors).toHaveLength(4);
      expect(d.anchors.map((a) => a.split(' — ')[0])).toEqual(['None', 'Mild', 'Moderate', 'Severe']);
      expect(d.rules.length).toBeGreaterThan(0);
    }
  });
});

describe('limitsBandFor', () => {
  it.each(AGE_BANDS)('%s → %s', (ageBand, expected) => {
    expect(limitsBandFor(ageBand)).toBe(expected);
  });
});

// Parse the markdown tables in docs/guard-rubric.md. The doc is the
// human-readable source; code and doc must not drift.
function docTable(heading: string, firstCell: string): string[][] {
  const doc = readFileSync(path.resolve(__dirname, '../../../docs/guard-rubric.md'), 'utf8');
  const start = doc.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const lines = doc.slice(start).split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith(`| ${firstCell} |`));
  expect(headerIdx).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(headerIdx)) {
    if (!line.startsWith('|')) break;
    if (/^\|[-| ]+\|$/.test(line)) continue;
    rows.push(line.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

function docBand(header: string): LimitsBand {
  if (header.startsWith('Under 10')) return 'under 10';
  if (header === '10–12') return '10-12';
  if (header === '13–15') return '13-15';
  throw new Error(`Unexpected band header in docs/guard-rubric.md: ${header}`);
}

describe('limits table parity with docs/guard-rubric.md', () => {
  it('has the same bands, dimensions and limits as the doc', () => {
    const [header, ...rows] = docTable('## Limits table', 'Dimension');
    const bands = header!.slice(1).map(docBand);
    expect(bands).toEqual([...LIMITS_BANDS]);
    expect(rows.map((r) => r[0])).toEqual(DIMENSIONS.map((d) => d.label));
    for (const row of rows) {
      const dim = DIMENSIONS.find((d) => d.label === row[0])!;
      bands.forEach((band, i) => {
        expect(LIMITS[band][dim.key], `${row[0]} / ${band}`).toBe(Number(row[i + 1]));
      });
    }
  });

  it('has the same flag actions as the doc', () => {
    const [header, ...rows] = docTable('### Flags', 'Flag');
    const bands = header!.slice(1).map(docBand);
    expect(rows.map((r) => r[0])).toEqual(FLAGS.map((f) => f.label));
    for (const row of rows) {
      const flag = FLAGS.find((f) => f.label === row[0])!;
      bands.forEach((band, i) => {
        const cell = row[i + 1]!;
        // Discovery never surfaces a flagged video, at any band.
        expect(cell).toMatch(/Discovery: never$/);
        const request = /^Request: (\w+)/.exec(cell)?.[1];
        expect(FLAG_REQUEST_ACTIONS[flag.key][band], `${row[0]} / ${band}`).toBe(request);
      });
    }
  });

  it('points readers of the doc at rubric.ts', () => {
    const doc = readFileSync(path.resolve(__dirname, '../../../docs/guard-rubric.md'), 'utf8');
    expect(doc).toContain('src/modules/guard/rubric.ts');
  });
});

// Reference mapping for dimensions alone, written independently of the
// implementation: worst over-limit amount decides.
function expectedFromDimensions(s: RubricScores, band: LimitsBand): RubricVerdict {
  let worst = 0;
  for (const k of DIMENSION_KEYS) worst = Math.max(worst, s.dimensions[k] - LIMITS[band][k]);
  return worst <= 0 ? 'clear_yes' : worst === 1 ? 'uncertain' : 'clear_no';
}

describe('verdictFromScores — dimensions', () => {
  it('all zeros is clear_yes with no drivers, in every band and context', () => {
    for (const [ageBand] of AGE_BANDS) {
      for (const context of ['discovery', 'request'] as const) {
        const d = verdictFromScores(scores(), ageBand, context);
        expect(d.verdict).toBe('clear_yes');
        expect(d.drivers).toEqual([]);
      }
    }
  });

  it('each dimension at every score, in every band: at limit → clear_yes, +1 → uncertain, +2 or more → clear_no', () => {
    for (const [ageBand, band] of AGE_BANDS) {
      for (const key of DIMENSION_KEYS) {
        for (const score of [0, 1, 2, 3] as const) {
          const limit = LIMITS[band][key];
          const expected: RubricVerdict = score <= limit ? 'clear_yes' : score - limit === 1 ? 'uncertain' : 'clear_no';
          const d = verdictFromScores(scores({ dimensions: { [key]: score } }), ageBand, 'discovery');
          expect(d.verdict, `${String(ageBand)} ${key}=${score}`).toBe(expected);
          expect(d.limitsBand).toBe(band);
          if (expected === 'clear_yes') {
            expect(d.drivers).toEqual([]);
          } else {
            expect(d.drivers).toEqual([{ kind: 'dimension', key, score, limit, over: score - limit, outcome: expected }]);
          }
        }
      }
    }
  });

  it('matches the reference mapping for every combination of dimension scores in every band', () => {
    const values = [0, 1, 2, 3] as const;
    for (const band of LIMITS_BANDS) {
      for (let n = 0; n < 4 ** DIMENSION_KEYS.length; n++) {
        const dims = {} as Record<RubricDimension, RubricScore>;
        let x = n;
        for (const k of DIMENSION_KEYS) {
          dims[k] = values[x % 4]!;
          x = Math.floor(x / 4);
        }
        const s = scores({ dimensions: dims });
        const d = verdictFromScores(s, band, 'request');
        const expected = expectedFromDimensions(s, band);
        if (d.verdict !== expected) {
          throw new Error(`${band} ${JSON.stringify(dims)}: got ${d.verdict}, expected ${expected}`);
        }
      }
    }
  });

  it('several dimensions over by one stay uncertain; any over by two makes it clear_no', () => {
    const twoOverByOne = scores({ dimensions: { language: 2, violence: 2 } });
    expect(verdictFromScores(twoOverByOne, 'under 10', 'request').verdict).toBe('uncertain');
    expect(verdictFromScores(twoOverByOne, 'under 10', 'request').drivers).toHaveLength(2);
    const mixed = scores({ dimensions: { language: 2, sexual: 2 } });
    const d = verdictFromScores(mixed, 'under 10', 'request');
    expect(d.verdict).toBe('clear_no');
    expect(d.drivers.map((x) => x.outcome)).toEqual(['uncertain', 'clear_no']);
  });

  it('attitude is the strictest: 2 is over in every band', () => {
    for (const band of LIMITS_BANDS) {
      expect(verdictFromScores(scores({ dimensions: { attitude: 2 } }), band, 'request').verdict).toBe('uncertain');
      expect(verdictFromScores(scores({ dimensions: { attitude: 3 } }), band, 'request').verdict).toBe('clear_no');
    }
  });

  it('16–17 and 18+ use the 13–15 limits', () => {
    const s = scores({ dimensions: { violence: 2, dangerous: 2, commercial: 2 } });
    expect(verdictFromScores(s, '13-15', 'request').verdict).toBe('clear_yes');
    expect(verdictFromScores(s, '16-17', 'request').verdict).toBe('clear_yes');
    expect(verdictFromScores(s, '18+', 'request').verdict).toBe('clear_yes');
    expect(verdictFromScores(s, '10-12', 'request').verdict).toBe('uncertain');
  });

  it('an unknown age uses the under-10 limits', () => {
    const s = scores({ dimensions: { sexual: 1 } });
    expect(verdictFromScores(s, null, 'request').verdict).toBe('uncertain');
    expect(verdictFromScores(s, 'nonsense', 'request').verdict).toBe('uncertain');
    expect(verdictFromScores(s, '10-12', 'request').verdict).toBe('clear_yes');
  });
});

describe('verdictFromScores — hard stops', () => {
  it('a clear hard stop is clear_no in every band and context, even with every dimension at 0', () => {
    for (const key of HARD_STOP_KEYS) {
      for (const [ageBand] of AGE_BANDS) {
        for (const context of ['discovery', 'request'] as const) {
          const d = verdictFromScores(scores({ hardStops: { [key]: 'clear' } }), ageBand, context);
          expect(d.verdict).toBe('clear_no');
          expect(d.drivers).toEqual([{ kind: 'hard_stop', key, level: 'clear', outcome: 'clear_no' }]);
        }
      }
    }
  });

  it('a suspected hard stop is at best uncertain — never clear_yes', () => {
    for (const key of HARD_STOP_KEYS) {
      for (const band of LIMITS_BANDS) {
        const d = verdictFromScores(scores({ hardStops: { [key]: 'suspected' } }), band, 'request');
        expect(d.verdict).toBe('uncertain');
        expect(d.drivers).toEqual([{ kind: 'hard_stop', key, level: 'suspected', outcome: 'uncertain' }]);
      }
    }
  });

  it('a suspected hard stop does not soften a dimension clear_no', () => {
    const s = scores({ hardStops: { hate: 'suspected' }, dimensions: { attitude: 3 } });
    expect(verdictFromScores(s, '13-15', 'request').verdict).toBe('clear_no');
  });
});

describe('verdictFromScores — flags', () => {
  it('discovery never surfaces a flagged video, in any band, naming the flag', () => {
    for (const key of FLAG_KEYS) {
      for (const [ageBand] of AGE_BANDS) {
        const d = verdictFromScores(scores({ flags: { [key]: true } }), ageBand, 'discovery');
        expect(d.verdict).toBe('clear_no');
        expect(d.drivers).toEqual([{ kind: 'flag', key, action: 'not_surfaced', outcome: 'clear_no' }]);
        expect(describeDriver(d.drivers[0]!)).toContain(FLAGS.find((f) => f.key === key)!.label);
      }
    }
  });

  it('requests apply the per-band action from the rubric', () => {
    const cases: Array<[RubricFlag, LimitsBand, RubricVerdict]> = [
      ['adult_game', 'under 10', 'uncertain'],
      ['adult_game', '10-12', 'uncertain'],
      ['adult_game', '13-15', 'clear_yes'],
      ['loot_box', 'under 10', 'uncertain'],
      ['loot_box', '10-12', 'clear_yes'],
      ['loot_box', '13-15', 'clear_yes'],
    ];
    for (const [key, band, expected] of cases) {
      const d = verdictFromScores(scores({ flags: { [key]: true } }), band, 'request');
      expect(d.verdict, `${key} / ${band}`).toBe(expected);
      if (expected === 'clear_yes') expect(d.drivers).toEqual([]);
      else expect(d.drivers).toEqual([{ kind: 'flag', key, action: 'escalate', outcome: 'uncertain' }]);
    }
  });

  it('flags only ever make a verdict stricter', () => {
    // Every base outcome × every flag combination × both contexts × every band.
    const bases: RubricScores[] = [
      scores(),
      scores({ dimensions: { attitude: 2 } }),
      scores({ dimensions: { attitude: 3 } }),
      scores({ hardStops: { manosphere: 'clear' } }),
    ];
    const rank: Record<RubricVerdict, number> = { clear_yes: 0, uncertain: 1, clear_no: 2 };
    for (const base of bases) {
      for (const band of LIMITS_BANDS) {
        for (const context of ['discovery', 'request'] as const) {
          const without = verdictFromScores(base, band, context).verdict;
          for (const flags of [
            { adult_game: true, loot_box: false },
            { adult_game: false, loot_box: true },
            { adult_game: true, loot_box: true },
          ]) {
            const withFlags = verdictFromScores({ ...base, flags }, band, context).verdict;
            expect(rank[withFlags]).toBeGreaterThanOrEqual(rank[without]);
          }
        }
      }
    }
  });

  it('an allowed flag leaves a dimension verdict as is', () => {
    const overByOne = scores({ dimensions: { violence: 3 }, flags: { adult_game: true } });
    expect(verdictFromScores(overByOne, '13-15', 'request').verdict).toBe('uncertain');
    const overByTwo = scores({ dimensions: { attitude: 3 }, flags: { loot_box: true } });
    expect(verdictFromScores(overByTwo, '13-15', 'request').verdict).toBe('clear_no');
  });
});

describe('driver descriptions', () => {
  it('uses rubric names and numbers only', () => {
    const d = verdictFromScores(
      scores({ dimensions: { dangerous: 3, attitude: 2 }, hardStops: { hate: 'suspected' }, flags: { loot_box: true } }),
      '10-12',
      'discovery',
    );
    expect(d.drivers.map(describeDriver)).toEqual([
      'Hard stop suspected: hate',
      'Dangerous acts 3 (limit 1)',
      'Attitude 2 (limit 1)',
      'Loot-box / pack opening: never surfaced by discovery',
    ]);
    expect(d.drivers.map(driverCountKey)).toEqual([
      'hard stop suspected: hate',
      'over by 2+: dangerous',
      'over by 1: attitude',
      'flag not_surfaced: loot_box',
    ]);
  });
});

// The text the model reads (anchors, rules, tests, hard stops, flag
// descriptions) is copied from the doc too. Each piece must appear in the doc,
// compared case- and whitespace-insensitively and ignoring trailing
// punctuation (the flag descriptions deliberately stop before the doc's clause
// about the parent's preference, which the model doesn't need), so editing one
// without the other fails here.
describe('rubric text parity with docs/guard-rubric.md', () => {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s*`]+/g, ' ').trim();
  const doc = norm(readFileSync(path.resolve(__dirname, '../../../docs/guard-rubric.md'), 'utf8'));

  const pieces: Array<[string, string]> = [
    ...DIMENSIONS.flatMap((d) => [
      ...d.anchors.map((a, i): [string, string] => [`${d.label} anchor ${i}`, a]),
      ...d.rules.map((r, i): [string, string] => [`${d.label} rule ${i}`, r]),
      ...(d.test ? [[`${d.label} test`, d.test] as [string, string]] : []),
    ]),
    ...HARD_STOPS.map((h): [string, string] => [`hard stop ${h.key}`, h.description]),
    ...FLAGS.map((f): [string, string] => [`flag ${f.key}`, f.description]),
  ];

  it.each(pieces)('%s appears in the doc', (_label, text) => {
    expect(doc).toContain(norm(text).replace(/[.;:,]+$/, ''));
  });
});
