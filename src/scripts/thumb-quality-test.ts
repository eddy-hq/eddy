import 'dotenv/config';
import { db } from '../db/client';
import { config } from '../config';
import { ollamaGenerate } from '../ollama';

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';

const PROMPT = `Look at this YouTube thumbnail image.

Classify it as either "editorial" or "slop" by overall composition style.

Editorial: clean photography or illustration, journalistic or magazine-cover composition, considered typography. Prominent title text is fine when it's in an editorial style — serif headlines, clean sans-serif, publisher wordmarks, album/podcast-cover typography.

Slop: manufactured shock expressions (open mouth, wide/bulging eyes, fake reactions), arrows or circles pointing at things, garish clashing colours, stroked/outlined "YouTuber" text styling, or composition clearly designed to bait clicks.

Text presence alone does not decide it — a calm magazine-cover thumbnail with a large title is editorial; a shocked face with clickbait arrows is slop even with little text.

Return ONLY valid JSON with no other text:
{
  "style": "editorial" or "slop",
  "reason": "one sentence",
  "confidence": 0.0 to 1.0
}`;

interface ThumbResult {
  style: 'editorial' | 'slop';
  reason: string;
  confidence: number;
}

async function fetchAsBase64(url: string): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

function parseResult(raw: string): ThumbResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  const style = parsed['style'];
  if (style !== 'editorial' && style !== 'slop') throw new Error(`Unexpected style: ${String(style)}`);
  return {
    style,
    reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : '',
    confidence: typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + '…';
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);

  function getArg(name: string): string | null {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` && args[i + 1]) return args[i + 1]!;
      if (args[i]?.startsWith(`--${name}=`)) return args[i]!.slice(name.length + 3);
    }
    return null;
  }

  const limit = parseInt(getArg('limit') ?? '20', 10);
  const channelFilter = getArg('channel');
  const idsArg = getArg('ids');
  const ids = idsArg ? idsArg.split(',').map((s) => s.trim()).filter(Boolean) : null;

  let rows: Array<{ youtube_id: string; title: string | null; channel: string | null }>;
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`
      SELECT youtube_id, title, channel
      FROM requests
      WHERE youtube_id IN (${placeholders})
    `).all(...ids) as typeof rows;
  } else {
    rows = db.prepare(`
      SELECT youtube_id, title, channel
      FROM requests
      WHERE youtube_id IS NOT NULL
        AND status IN ('ready', 'watched')
        ${channelFilter ? `AND lower(channel) LIKE lower('%' || ? || '%')` : ''}
      ORDER BY added_at DESC
      LIMIT ?
    `).all(...(channelFilter ? [channelFilter, limit] : [limit])) as typeof rows;
  }

  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No videos found.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`\n${BOLD}Classifying ${rows.length} thumbnails using ${config.OLLAMA_GUARD_MODEL}…${RESET}\n`);

  let editorial = 0;
  let slop = 0;
  let failed = 0;

  for (const row of rows) {
    const thumbUrl = `https://i.ytimg.com/vi/${row.youtube_id}/hqdefault.jpg`;
    const title   = row.title ?? row.youtube_id;
    const channel = row.channel ?? '—';

    let result: ThumbResult;
    try {
      const b64 = await fetchAsBase64(thumbUrl);
      const raw = await ollamaGenerate(PROMPT, config.OLLAMA_GUARD_MODEL, [b64]);
      result = parseResult(raw);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`  ${DIM}  error  ${truncate(channel, 24)} ${truncate(title, 52)} ${String(err)}${RESET}`);
      failed++;
      continue;
    }

    const colour = result.style === 'editorial' ? GREEN : RED;
    const conf   = `${Math.round(result.confidence * 100)}%`;
    // eslint-disable-next-line no-console
    console.log(
      `  ${colour}${result.style === 'editorial' ? 'editorial' : '     slop'}${RESET}` +
      `  ${DIM}${truncate(channel, 24)}${RESET}` +
      `  ${truncate(title, 52)}` +
      `  ${DIM}${conf}  ${result.reason}${RESET}`
    );

    if (result.style === 'editorial') editorial++; else slop++;
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${BOLD}Summary:${RESET} ${GREEN}${editorial} editorial${RESET}` +
    `, ${RED}${slop} slop${RESET}` +
    (failed ? `, ${DIM}${failed} failed${RESET}` : '') +
    ` — of ${rows.length} videos\n`
  );
}

run().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Script failed:', err);
  process.exit(1);
});
