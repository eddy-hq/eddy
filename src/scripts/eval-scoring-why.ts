#!/usr/bin/env tsx
/* eslint-disable no-console */
import 'dotenv/config';
import { config } from '../config';
import { db } from '../db/client';
import { ollamaGenerate } from '../ollama';
import { buildScoringPrompt, parseScoringVerdict } from '../modules/discovery/scoring';

type ScoringItems = Parameters<typeof buildScoringPrompt>[0];

interface UserRow {
  user_id: string;
  display_name: string;
  role: string;
}

interface CandidateRow {
  candidate_id: string;
  title: string | null;
  channel: string | null;
  duration_secs: number | null;
  published_at: string | null;
  source_type: string;
  interest_id: string | null;
  person_id: string | null;
  interest_label: string | null;
  interest_expertise: string | null;
  person_name: string | null;
}

interface EvalRow {
  userName: string;
  index: number;
  title: string;
  sourceType: string;
  personName: string | null;
  why: string | null;
  flags: string[];
}

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const ANALYST_PHRASES = [
  /\bconnects to your interest\b/i,
  /\bdeep interest\b/i,
  /\bdiscusses\b/i,
  /\b(?:this video|it)\s+details\b/i,
  /\bdirectly address(?:es|ing)?\b/i,
  /\bthis video\b/i,
];
const ADDRESSED_TO_USER = /\b(you|you've|you'd|your)\b/i;

function getArg(name: string): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1]) return args[i + 1]!;
    if (args[i]?.startsWith(`--${name}=`)) return args[i]!.slice(name.length + 3);
  }
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value.padEnd(width) : `${value.slice(0, width - 1)}…`;
}

function flagWhy(title: string, sourceType: string, why: string | undefined): string[] {
  const flags: string[] = [];
  const trimmed = why?.trim() ?? '';

  if (!trimmed) flags.push('missing');
  if (trimmed && trimmed.toLowerCase() === title.trim().toLowerCase()) flags.push('title-parrot');
  if (trimmed && !/[.!?]$/.test(trimmed)) flags.push('not-sentence');
  if (trimmed && !ADDRESSED_TO_USER.test(trimmed)) flags.push('not-addressed');
  for (const phrase of ANALYST_PHRASES) {
    if (phrase.test(trimmed)) flags.push('analyst-tone');
  }
  if (
    (sourceType === 'person_backcatalog' || sourceType === 'subscription') &&
    /\b(?:because|since)\s+you\s+follow\b/i.test(trimmed)
  ) {
    flags.push('follow-as-reason');
  }
  if (/\bsourced from\b/i.test(trimmed)) flags.push('provenance-as-reason');
  if (/\b(subscription|back-?catalog(?:ue)?)\b/i.test(trimmed)) flags.push('provenance-as-reason');

  return [...new Set(flags)];
}

function getUsers(target: string | null): UserRow[] {
  if (target) {
    return db.prepare(`
      SELECT user_id, display_name, role
      FROM users
      WHERE user_id = ? OR lower(display_name) = lower(?)
    `).all(target, target) as UserRow[];
  }

  return db.prepare(`
    SELECT DISTINCT u.user_id, u.display_name, u.role
    FROM users u
    INNER JOIN candidate_pool c ON c.user_id = u.user_id
    WHERE c.status IN ('pending', 'scored')
    ORDER BY u.display_name ASC
  `).all() as UserRow[];
}

function getInterestSummary(userId: string): string {
  const rows = db.prepare(`
    SELECT i.label, ui.expertise
    FROM user_interests ui
    INNER JOIN interests i ON i.id = ui.interest_id
    WHERE ui.user_id = ?
    ORDER BY ui.rank ASC
  `).all(userId) as Array<{ label: string; expertise: string }>;

  return rows.map((row) => `"${row.label}" (${row.expertise})`).join(', ');
}

function getAffinityStatements(userId: string): string[] {
  const rows = db.prepare(`
    SELECT statement
    FROM inferred_affinities
    WHERE user_id = ? AND superseded_at IS NULL
    ORDER BY confidence DESC, generated_at DESC
    LIMIT 5
  `).all(userId) as Array<{ statement: string }>;
  return rows.map((row) => row.statement);
}

function getCandidates(userId: string, limit: number, sourceType: string | null): CandidateRow[] {
  return db.prepare(`
    SELECT c.candidate_id, c.title, c.channel, c.duration_secs,
           c.published_at, c.source_type, c.interest_id, c.person_id,
           i.label AS interest_label,
           ui.expertise AS interest_expertise,
           p.display_name AS person_name
    FROM candidate_pool c
    LEFT JOIN interests i ON i.id = c.interest_id
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    LEFT JOIN people p ON p.person_id = c.person_id
    WHERE c.user_id = ?
      AND c.status IN ('pending', 'scored')
      AND (? IS NULL OR c.source_type = ?)
    ORDER BY c.created_at DESC
    LIMIT ?
  `).all(userId, sourceType, sourceType, limit) as CandidateRow[];
}

function toScoringItems(rows: CandidateRow[]): ScoringItems {
  return rows.map((row, idx) => ({
    index: idx + 1,
    candidateId: row.candidate_id,
    title: row.title ?? '(no title)',
    channel: row.channel ?? '',
    durationSecs: row.duration_secs,
    publishedAt: row.published_at,
    interestLabel: row.interest_label,
    expertise: row.interest_expertise,
    sourceType: row.source_type,
    personId: row.person_id,
    personName: row.person_name,
  }));
}

function fixtureItems(): ScoringItems {
  return [
    {
      index: 1,
      candidateId: 'eval-title-bait-1',
      title: 'Tool Calling Is Not Just Plumbing for AI Agents — Roy Derks',
      channel: 'Conference Talks',
      durationSecs: 2100,
      publishedAt: '2026-05-10T10:00:00.000Z',
      interestLabel: 'AI agents',
      expertise: 'deep',
      sourceType: 'interest_search',
      personId: null,
      personName: null,
    },
    {
      index: 2,
      candidateId: 'eval-subscription-1',
      title: 'Why Gyroscopes Refuse to Fall Over',
      channel: 'Steve Mould',
      durationSecs: 1140,
      publishedAt: '2026-05-21T10:00:00.000Z',
      interestLabel: null,
      expertise: null,
      sourceType: 'subscription',
      personId: 'person-mould',
      personName: 'Steve Mould',
    },
  ];
}

async function scoreRows(
  userName: string,
  items: ScoringItems,
  interestSummary: string,
  affinityStatements: string[],
): Promise<EvalRow[]> {
  const prompt = buildScoringPrompt(items, interestSummary, affinityStatements);
  const raw = await ollamaGenerate(prompt, config.OLLAMA_GUARD_MODEL, undefined, {
    num_predict: 3000,
    temperature: 0.2,
  });
  const parsed = parseScoringVerdict(raw);

  if (!parsed) {
    return items.map((item) => ({
      userName,
      index: item.index,
      title: item.title,
      sourceType: item.sourceType,
      personName: item.personName,
      why: null,
      flags: ['parse-failed'],
    }));
  }

  return items.map((item) => {
    const entry = parsed.find((candidate) => candidate.index === item.index);
    const why = entry?.why?.trim() ?? null;
    return {
      userName,
      index: item.index,
      title: item.title,
      sourceType: item.sourceType,
      personName: item.personName,
      why,
      flags: flagWhy(item.title, item.sourceType, why ?? undefined),
    };
  });
}

async function main(): Promise<void> {
  const limit = Number.parseInt(getArg('limit') ?? '8', 10);
  const userArg = getArg('user');
  const sourceType = getArg('source-type');
  const useFixtures = hasFlag('fixtures');

  console.log(`\n${BOLD}Scoring why eval${RESET} using ${config.OLLAMA_GUARD_MODEL}`);
  console.log(`${DIM}Default mode samples live candidate_pool rows with status pending/scored and does not write to the DB.${RESET}\n`);

  const allRows: EvalRow[] = [];

  if (useFixtures) {
    console.log(`${DIM}Running fixture mode…${RESET}`);
    allRows.push(...await scoreRows(
      'fixtures',
      fixtureItems(),
      '"AI agents" (deep), "physics explainers" (comfortable)',
      ['Likes practical explanations, not headline fragments.'],
    ));
  } else {
    const users = getUsers(userArg);
    if (users.length === 0) {
      console.log('No users with pending/scored candidates found.');
      return;
    }

    for (const user of users) {
      const candidates = getCandidates(user.user_id, limit, sourceType);
      if (candidates.length === 0) continue;

      console.log(`${DIM}Running ${user.display_name} (${user.role}) with ${candidates.length} live candidates…${RESET}`);
      allRows.push(...await scoreRows(
        user.display_name,
        toScoringItems(candidates),
        getInterestSummary(user.user_id),
        getAffinityStatements(user.user_id),
      ));
    }
  }

  if (allRows.length === 0) {
    console.log('No candidates matched.');
    return;
  }

  let failures = 0;
  console.log('');
  console.log(`${BOLD}${truncate('user', 16)} ${truncate('source', 18)} ${truncate('person', 18)} ${truncate('title', 48)} why${RESET}`);
  for (const row of allRows) {
    const ok = row.flags.length === 0;
    if (!ok) failures++;
    const colour = ok ? GREEN : RED;
    const flags = ok ? `${GREEN}ok${RESET}` : `${RED}${row.flags.join(',')}${RESET}`;
    console.log(
      `${colour}${truncate(row.userName, 16)}${RESET} ` +
      `${truncate(row.sourceType, 18)} ` +
      `${truncate(row.personName ?? '-', 18)} ` +
      `${truncate(row.title, 48)} ` +
      `${row.why ?? '(missing)'} ${DIM}[${flags}${DIM}]${RESET}`
    );
  }

  const colour = failures === 0 ? GREEN : YELLOW;
  console.log(`\n${colour}${failures === 0 ? 'PASS' : 'REVIEW'}${RESET}: ${allRows.length - failures}/${allRows.length} rows passed mechanical checks.`);
  console.log(`${DIM}Useful args: --user <name-or-id> --limit 12 --source-type interest_search --fixtures${RESET}\n`);

  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('Scoring why eval failed:', err);
  process.exit(1);
});
