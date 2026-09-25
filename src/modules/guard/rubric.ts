// Guard rubric v1 as versioned code (Phase 6a, brief §9 and §22, ADR-0014).
//
// docs/guard-rubric.md is the human-readable source; this file is what the
// guard reads. Models score the dimensions and detect hard stops and flags;
// verdictFromScores applies the limits table and decides. Change the doc and
// this file together and bump RUBRIC_VERSION — rubric.test.ts fails if the
// limits tables drift apart.

export const RUBRIC_VERSION = 'rubric-v1.2';

export type RubricScore = 0 | 1 | 2 | 3;

export const DIMENSION_KEYS = [
  'language',
  'violence',
  'frightening',
  'sexual',
  'substances',
  'dangerous',
  'commercial',
  'attitude',
] as const;
export type RubricDimension = (typeof DIMENSION_KEYS)[number];

export const HARD_STOP_KEYS = ['self_harm', 'hate', 'child_sexualisation', 'manosphere'] as const;
export type HardStop = (typeof HARD_STOP_KEYS)[number];
export type HardStopLevel = 'none' | 'suspected' | 'clear';

export const FLAG_KEYS = ['adult_game', 'loot_box'] as const;
export type RubricFlag = (typeof FLAG_KEYS)[number];

export interface DimensionSpec {
  key: RubricDimension;
  // The row label in the doc's limits table.
  label: string;
  // A copy-risk style test some dimensions carry ahead of their anchors.
  test?: string;
  // Index = score: 0 None, 1 Mild, 2 Moderate, 3 Severe.
  anchors: readonly [string, string, string, string];
  rules: readonly string[];
}

export const DIMENSIONS: readonly DimensionSpec[] = [
  {
    key: 'language',
    label: 'Language',
    anchors: [
      'None — nothing a teacher would react to. "Oh my gosh", "oh my God", "what the heck", "rubbish".',
      'Mild — occasional mild swearing or bleeped strong words. "Bloody", "damn", "crap", "hell", toilet humour, a bleeped f-word.',
      'Moderate — regular mild swearing or occasional unbleeped strong swearing. A streamer swearing when losing, a couple of unbleeped f-words in a 20-minute video, crude insults between friends.',
      'Severe — frequent strong swearing or the worst words. F-word every sentence, the c-word, graphic sexual slang.',
    ],
    rules: [
      'one slip in a long video scores a level lower than sustained use',
      'bleeped scores a level lower',
      'swearing aimed at someone (abuse) scores a level higher',
      "context (football, gaming) doesn't change the score",
      'slurs go to the hate hard stop or Attitude, not here',
    ],
  },
  {
    key: 'violence',
    label: 'Violence',
    anchors: [
      'None — no harm shown. Ordinary sport, cooking, science.',
      'Mild — stylised or cartoon, no blood. Slapstick, ordinary Minecraft/Fortnite fighting, hard football tackles, nature-doc hunts without close-ups.',
      'Moderate — realistic with some blood, or brief real fights. Realistic shooter gameplay, boxing/MMA knockouts, a brief real street-fight clip, war-documentary footage.',
      'Severe — gore, torture, real serious injury or death. Graphic horror kills, real accident or war casualties, animal cruelty, sustained real beatings.',
    ],
    rules: [
      'real scores a level higher than equivalent fiction',
      'glorified or gratuitous (fight compilations set to music, "most brutal knockouts") scores a level higher',
      "educational framing doesn't lower the score but is noted in the reason",
      'realistic real-world weapons (modern firearms shown as real guns) score at least 2, even inside a stylised game',
      'torture or cruelty as the premise scores at least 2, even when stylised or played for laughs',
    ],
  },
  {
    key: 'frightening',
    label: 'Frightening',
    anchors: [
      'None — nothing unsettling.',
      'Mild — spooky for fun, played light. Halloween content, cartoon monsters, a Minecraft horror map played for laughs, "creepy facts" told cheerfully.',
      'Moderate — real tension and jump scares, meant to scare. Straight horror-game playthroughs (FNAF, Poppy Playtime — kid-targeted horror is still horror), creepypasta and analog horror, unsolved mysteries, disaster footage without casualties, restrained true crime (narrated case, real victims, no graphic detail).',
      'Severe — designed to disturb, or real people in real danger or death. Graphic horror, true crime that dwells on victims or graphic detail, real accident or death footage, people in genuine peril.',
    ],
    rules: [
      'real scores a level higher than fiction (restrained true crime is the named exception, anchored at 2)',
      'sustained scores a level higher than brief — one jump scare in a funny video stays at 1',
      'shock-bait titles or thumbnails are noted in the reason even when the content is tamer',
    ],
  },
  {
    key: 'sexual',
    label: 'Sexual',
    anchors: [
      'None — nothing sexual.',
      "Mild — romance or innuendo that goes over most kids' heads. Kissing, a crush storyline, a passing double entendre, swimwear in a normal context (beach vlog, swimming).",
      'Moderate — overt sexual jokes or suggestiveness as the focus. Repeated sexual jokes, thirst-trap framing, suggestive dancing or outfits as the point of the video, frank talk about sex without explicit detail.',
      'Severe — nudity or explicit sexual content. Nudity, sexual acts shown or described in detail, fetish content.',
    ],
    rules: [
      'clearly educational sex/puberty content is capped at 1 whatever the topic (the one place framing lowers a score)',
      '"rizz", dating-influencer and rating-girls content scores under Attitude, not here — only explicit sexual talk scores here',
      'sexualisation of children is a hard stop, never a score',
    ],
  },
  {
    key: 'substances',
    label: 'Substances',
    anchors: [
      'None — nothing.',
      'Mild — incidental, background, or educational. Adults with a pint in a football vlog, a film character smoking, drug-awareness content.',
      'Moderate — use shown as the subject, or casually glamorised. A creator vaping on camera, "getting drunk" stories told as funny, drinking games in a vlog.',
      'Severe — drug use shown or taught, or substance culture celebrated. Drug use on camera, how to obtain, vape-trick tutorials, heavy drinking as the point.',
    ],
    rules: [
      'glamorised scores a level higher',
      'a creator using on camera weighs more than a depiction',
      'clearly educational awareness content is capped at 1',
      'energy drinks are not substances — brand hype scores under Commercial pressure, caffeine challenges under Dangerous acts',
    ],
  },
  {
    key: 'dangerous',
    label: 'Dangerous acts',
    test: "how easily could a 12-year-old copy it with what's at home or outside?",
    anchors: [
      'None — nothing risky.',
      'Mild — risk handled by professionals, or low stakes. Pro parkour or extreme sports, science demos with safety framing, knife skills in cooking.',
      'Moderate — copyable amateur risk, minor harm likely. Amateur trampoline or skate stunts, spicy-food and caffeine challenges, physical pranks, urban exploring, fail compilations.',
      'Severe — copyable with serious harm possible. Viral challenges (blackout, fire, chroming), rooftopping, train surfing, car stunts on public roads, weapons, explosives, homemade pyrotechnics.',
    ],
    rules: [
      'framed as an invitation ("try this", "challenge your mates") scores a level higher',
      'harm shown without consequence (injury as punchline) scores a level higher — fail compilations are anchored at 2 on this basis',
      'a professional setting with visible safety anchors at 1 however extreme the stunt',
    ],
  },
  {
    key: 'commercial',
    label: 'Commercial',
    anchors: [
      'None — nothing being sold. Incidental betting branding in football (shirt sponsors, pitch boards, a half-time ad) scores 0 — unavoidable in UK football.',
      'Mild — standard disclosed ads and reviews. A labelled sponsor read, honest reviews, "link in description".',
      'Moderate — selling woven into the content, or aimed at kids. Undisclosed or blended sponsorship, merch pushed at young fans, energy-drink brand hype, haul flexing, loot-box / pack openings presented as exciting.',
      'Severe — gambling, gambling-like mechanics, or get-rich schemes. Real-money case openings or skin gambling, casino or slots streams, a creator promoting betting, crypto or trading "hustle", "free V-Bucks/Robux" scams.',
    ],
    rules: [
      'pitched directly at kids ("ask your parents", "use my code") scores a level higher',
      'undisclosed scores a level higher',
    ],
  },
  {
    key: 'attitude',
    label: 'Attitude',
    anchors: [
      'None — neutral or positive.',
      "Mild — edgy but good-natured. Roast humour between willing friends, cheeky rudeness, harmless pranks where everyone's laughing.",
      'Moderate — cruelty or contempt as entertainment. Pranks where someone\'s distress is the point, "rizz" and rating-girls content, mocking a group (short of hate), wealth-flexing as aspiration, conspiracy-lite.',
      'Severe — an ideology, or a real target. Bullying a real identifiable person, dehumanising humour about a group, glamorised gang or crime culture. (Manosphere worldview is a hard stop, not a 3.)',
    ],
    rules: [
      'presented as advice or worldview ("this is how men should…") scores a level higher than a one-off joke',
      'a real identifiable target scores a level higher than fiction or a willing participant',
    ],
  },
];

export interface HardStopSpec {
  key: HardStop;
  description: string;
}

export const HARD_STOPS: readonly HardStopSpec[] = [
  { key: 'self_harm', description: 'Self-harm / suicide content (beyond respectful educational treatment)' },
  { key: 'hate', description: 'Hate targeting a group' },
  { key: 'child_sexualisation', description: 'Any sexualisation of children (Elsagate-style)' },
  {
    key: 'manosphere',
    description: 'Manosphere / misogyny as a worldview (Tate-style; "alpha" content that tips into contempt for women). Fitness, discipline or study motivation without contempt is not a hard stop.',
  },
];

export interface FlagSpec {
  key: RubricFlag;
  label: string;
  description: string;
}

export const FLAGS: readonly FlagSpec[] = [
  {
    key: 'adult_game',
    label: 'Adult-rated game',
    description: 'gameplay or content from a PEGI 18 / ESRB M title (GTA, Call of Duty, …). Dimensions are still scored on what is actually shown.',
  },
  {
    key: 'loot_box',
    label: 'Loot-box / pack opening',
    description: 'pack or case openings with loot-box mechanics (EA FC Ultimate Team, etc.). Scored Commercial 2 on its own facts.',
  },
];

// The bands the limits table defines. 16–17 and 18+ are not yet set and use
// 13–15; an unknown or unparseable band uses under 10 (the most restrictive).
export const LIMITS_BANDS = ['under 10', '10-12', '13-15'] as const;
export type LimitsBand = (typeof LIMITS_BANDS)[number];

export const LIMITS: Readonly<Record<LimitsBand, Readonly<Record<RubricDimension, RubricScore>>>> = {
  'under 10': {
    language: 1, violence: 1, frightening: 1, sexual: 0,
    substances: 0, dangerous: 1, commercial: 1, attitude: 1,
  },
  '10-12': {
    language: 2, violence: 1, frightening: 1, sexual: 1,
    substances: 1, dangerous: 1, commercial: 1, attitude: 1,
  },
  '13-15': {
    language: 2, violence: 2, frightening: 2, sexual: 1,
    substances: 1, dangerous: 2, commercial: 2, attitude: 1,
  },
};

export type FlagRequestAction = 'escalate' | 'allow';

// Discovery never surfaces a flagged video, at any band. Requests act per band.
export const FLAG_REQUEST_ACTIONS: Readonly<Record<RubricFlag, Readonly<Record<LimitsBand, FlagRequestAction>>>> = {
  adult_game: { 'under 10': 'escalate', '10-12': 'escalate', '13-15': 'allow' },
  loot_box: { 'under 10': 'escalate', '10-12': 'allow', '13-15': 'allow' },
};

// Map an age band (users.getAgeBand's strings) onto the limits table's bands.
export function limitsBandFor(ageBand: string | null | undefined): LimitsBand {
  switch (ageBand) {
    case '10-12':
      return '10-12';
    case '13-15':
    case '16-17':
    case '18+':
      return '13-15';
    default:
      return 'under 10';
  }
}

export interface RubricScores {
  dimensions: Record<RubricDimension, RubricScore>;
  hardStops: Record<HardStop, HardStopLevel>;
  flags: Record<RubricFlag, boolean>;
}

export type RubricContext = 'discovery' | 'request';
export type RubricVerdict = 'clear_yes' | 'uncertain' | 'clear_no';

// One item that moved the verdict off clear_yes, with the verdict it alone
// would have produced. Names and numbers only — never content.
export type VerdictDriver =
  | { kind: 'hard_stop'; key: HardStop; level: 'suspected' | 'clear'; outcome: 'uncertain' | 'clear_no' }
  | { kind: 'dimension'; key: RubricDimension; score: RubricScore; limit: RubricScore; over: number; outcome: 'uncertain' | 'clear_no' }
  | { kind: 'flag'; key: RubricFlag; action: 'not_surfaced' | 'escalate'; outcome: 'uncertain' | 'clear_no' };

export interface RubricDecision {
  verdict: RubricVerdict;
  limitsBand: LimitsBand;
  context: RubricContext;
  // Every item that pushed the verdict off clear_yes. Empty for clear_yes.
  drivers: VerdictDriver[];
}

const STRICTNESS: Record<RubricVerdict, number> = { clear_yes: 0, uncertain: 1, clear_no: 2 };

function stricter(a: RubricVerdict, b: RubricVerdict): RubricVerdict {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

// The verdict mapping (docs/guard-rubric.md, "Verdict mapping" and "Flags"):
//   - a clear hard stop → clear_no; a suspected one → at best uncertain
//   - every dimension within its limit → clear_yes
//   - a dimension over by exactly one → uncertain; by two or more → clear_no
//   - then flags: discovery never surfaces a flagged video (clear_no); a
//     request escalates or allows per band.
// Every step can only make the verdict stricter, never looser.
export function verdictFromScores(
  scores: RubricScores,
  ageBand: string | null | undefined,
  context: RubricContext,
): RubricDecision {
  const limitsBand = limitsBandFor(ageBand);
  const limits = LIMITS[limitsBand];
  const drivers: VerdictDriver[] = [];
  let verdict: RubricVerdict = 'clear_yes';

  for (const key of HARD_STOP_KEYS) {
    const level = scores.hardStops[key];
    if (level === 'clear' || level === 'suspected') {
      const outcome = level === 'clear' ? 'clear_no' : 'uncertain';
      drivers.push({ kind: 'hard_stop', key, level, outcome });
      verdict = stricter(verdict, outcome);
    }
  }

  for (const key of DIMENSION_KEYS) {
    const score = scores.dimensions[key];
    const limit = limits[key];
    const over = score - limit;
    if (over > 0) {
      const outcome = over >= 2 ? 'clear_no' : 'uncertain';
      drivers.push({ kind: 'dimension', key, score, limit, over, outcome });
      verdict = stricter(verdict, outcome);
    }
  }

  for (const key of FLAG_KEYS) {
    if (!scores.flags[key]) continue;
    if (context === 'discovery') {
      drivers.push({ kind: 'flag', key, action: 'not_surfaced', outcome: 'clear_no' });
      verdict = stricter(verdict, 'clear_no');
    } else if (FLAG_REQUEST_ACTIONS[key][limitsBand] === 'escalate') {
      drivers.push({ kind: 'flag', key, action: 'escalate', outcome: 'uncertain' });
      verdict = stricter(verdict, 'uncertain');
    }
  }

  return { verdict, limitsBand, context, drivers };
}

// Short parent-readable description of a driver, e.g. "Violence 3 (limit 1)"
// or "Adult-rated game: never surfaced by discovery". Rubric names and
// numbers only, so it is safe in logs and summaries.
export function describeDriver(d: VerdictDriver): string {
  switch (d.kind) {
    case 'hard_stop':
      return `Hard stop ${d.level}: ${d.key.replace(/_/g, ' ')}`;
    case 'dimension': {
      const label = DIMENSIONS.find((x) => x.key === d.key)?.label ?? d.key;
      return `${label} ${d.score} (limit ${d.limit})`;
    }
    case 'flag': {
      const label = FLAGS.find((x) => x.key === d.key)?.label ?? d.key;
      return d.action === 'not_surfaced'
        ? `${label}: never surfaced by discovery`
        : `${label}: escalated to a parent`;
    }
  }
}

// Aggregation key for counting drivers across a run, e.g.
// "dimension over by 1: attitude". No scores beyond the over-by amount.
export function driverCountKey(d: VerdictDriver): string {
  switch (d.kind) {
    case 'hard_stop':
      return `hard stop ${d.level}: ${d.key}`;
    case 'dimension':
      return d.over >= 2 ? `over by 2+: ${d.key}` : `over by 1: ${d.key}`;
    case 'flag':
      return `flag ${d.action}: ${d.key}`;
  }
}
