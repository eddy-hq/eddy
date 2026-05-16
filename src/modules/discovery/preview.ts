import { db } from '../../db/client';
import { rank, type RankerCandidate, type Verdict, type Disposition } from './ranker';

interface UserRow { user_id: string; role: string; age_gate: number; display_name: string; }

interface CandidateRow {
  candidate_id: string;
  external_id: string | null;
  url: string;
  title: string | null;
  channel: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_secs: number | null;
  connection_score: number | null;
  quality_score: number | null;
  time_sensitivity: string | null;
  why_text: string | null;
  guard_verdict: string | null;
  interest_id: string | null;
  interest_label: string | null;
  rank: number;
}

interface Card {
  row: CandidateRow;
  verdict: Verdict;
}

interface Section {
  user: UserRow;
  selected: Card[];
  rest: Card[];
  totals: {
    pool: number;
    eligible: number;
    rejected: number;
    selected: number;
    cap: number;
  };
}

function ageLabel(iso: string | null): string {
  if (!iso) return 'unknown age';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function durationLabel(secs: number | null): string {
  if (secs === null || secs <= 0) return '';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

const DISPOSITION_LABEL: Record<Disposition, string> = {
  regular: 'regular',
  stretch: 'stretch',
  low_conn: 'low conn',
  low_qual: 'low qual',
  low_both: 'low both',
  low_weight: 'low weight',
  cut_interest_cap: 'cut · interest cap',
  cut_dedup: 'cut · dedup',
  cut_stretch_rank: 'cut · stretch rank',
};

const DISPOSITION_CLASS: Record<Disposition, string> = {
  regular: 'regular',
  stretch: 'stretch',
  low_conn: 'low',
  low_qual: 'low',
  low_both: 'low-both',
  low_weight: 'low-weight',
  cut_interest_cap: 'cut-interest-cap',
  cut_dedup: 'cut-dedup',
  cut_stretch_rank: 'cut-stretch-rank',
};

function buildSection(user: UserRow): Section {
  const isKid = user.role === 'kid';
  const cap = isKid ? 5 : 15;

  const guardClause = isKid
    ? "AND (c.guard_verdict = 'clear_yes' OR c.guard_verdict IS NULL)"
    : '';

  // Data-shape SQL only — identical filters to surface.ts. Floors live
  // in the ranker; preview never re-applies them in JS.
  const rows = db.prepare(`
    SELECT c.candidate_id, c.external_id, c.url, c.title, c.channel,
           c.thumbnail_url, c.published_at, c.duration_secs,
           c.connection_score, c.quality_score, c.time_sensitivity,
           c.why_text, c.guard_verdict,
           c.interest_id, i.label AS interest_label,
           COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    LEFT JOIN interests i ON i.id = c.interest_id
    WHERE c.user_id = ?
      AND c.status = 'scored'
      AND c.surfaced_date IS NULL
      AND c.why_text IS NOT NULL
      ${guardClause}
      AND NOT EXISTS (
        SELECT 1 FROM requests r
        WHERE r.user_id = c.user_id AND r.youtube_id = c.external_id
      )
  `).all(user.user_id) as CandidateRow[];

  const candidates: RankerCandidate[] = rows.map((r) => ({
    candidateId: r.candidate_id,
    title: r.title,
    publishedAt: r.published_at,
    connectionScore: r.connection_score,
    qualityScore: r.quality_score,
    timeSensitivity: r.time_sensitivity,
    interestId: r.interest_id,
    rank: r.rank,
  }));

  // Preview always simulates a clean run — no prefill.
  const verdicts = rank(
    candidates,
    { now: new Date(), isKid, prefilledTitles: [], prefilledInterestCounts: new Map() },
    { cap },
  );

  const rowById = new Map(rows.map((r) => [r.candidate_id, r]));
  const cards: Card[] = verdicts.map((v) => {
    const row = rowById.get(v.candidate.candidateId);
    if (!row) throw new Error(`preview: missing row for ${v.candidate.candidateId}`);
    return { row, verdict: v };
  });

  const selected = cards.filter((c) => c.verdict.disposition === 'regular' || c.verdict.disposition === 'stretch');
  const rest = cards.filter((c) => c.verdict.disposition !== 'regular' && c.verdict.disposition !== 'stretch');
  const rejected = cards.filter((c) => c.verdict.disposition.startsWith('low_')).length;

  return {
    user,
    selected,
    rest,
    totals: {
      pool: rows.length,
      eligible: rows.length - rejected,
      rejected,
      selected: selected.length,
      cap,
    },
  };
}

const css = `
:root {
  --bg: #1a1916; --bg-card: #222220; --bg-elevated: #2a2926;
  --fg: #e8e6e0; --fg-muted: #888580; --fg-dim: #5a5854;
  --border: #353330; --accent: #d4a85a;
  --slot-regular: #6ba368; --slot-stretch: #d4a85a;
  --slot-low: #c97a4a; --slot-low-both: #b8534a; --slot-cut: #5a5854;
  --slot-cut-interest-cap: #7a4a8a; /* purple — interest-cap rejections */
  --slot-cut-dedup: #4a6a8a;        /* blue — title-similarity rejections */
  --slot-cut-stretch-rank: #5a8a5a; /* green-grey — stretch-rank rejections */
  --tag-news: #8a4a4a; --tag-evergreen: #4a8a8a; --tag-standard: #5a5854;
  --tag-actually-surfaced: #5a8a9a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; padding: 24px; }
h1 { font-size: 20px; font-weight: 600; margin-bottom: 6px; }
h2 { font-size: 14px; font-weight: 600; color: var(--fg-muted); margin: 24px 0 12px; text-transform: uppercase; letter-spacing: 0.6px; }
h2 .muted { color: var(--fg-dim); font-weight: 400; text-transform: none; letter-spacing: 0; }
.summary { color: var(--fg-muted); font-size: 13px; margin-bottom: 8px; }
.summary strong { color: var(--fg); font-weight: 600; }
.toolbar { margin-bottom: 24px; padding: 12px 16px; background: var(--bg-card); border-radius: 8px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.toolbar a { color: var(--fg-muted); text-decoration: none; padding: 4px 10px; border-radius: 4px; font-size: 13px; }
.toolbar a:hover { background: var(--bg-elevated); color: var(--fg); }
.toolbar a.active { background: var(--accent); color: var(--bg); font-weight: 600; }
.section { margin-bottom: 40px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
.grid.selected .card { border: 2px solid var(--slot-regular); }
.grid.selected .card.stretch-card { border-color: var(--slot-stretch); }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; transition: transform 0.1s; position: relative; }
.card:hover { transform: translateY(-2px); }
.thumb-wrap { position: relative; aspect-ratio: 16/9; background: #000; }
.thumb-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-fallback { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--fg-dim); font-size: 12px; }
.duration { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.85); color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; }
.slot-tag { position: absolute; top: 8px; left: 8px; background: var(--slot-cut); color: white; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.slot-tag.regular { background: var(--slot-regular); }
.slot-tag.stretch { background: var(--slot-stretch); color: #1a1916; }
.slot-tag.low { background: var(--slot-low); }
.slot-tag.low-both { background: var(--slot-low-both); }
.slot-tag.low-weight { background: var(--slot-cut); }
.slot-tag.cut-interest-cap { background: var(--slot-cut-interest-cap); }
.slot-tag.cut-dedup { background: var(--slot-cut-dedup); }
.slot-tag.cut-stretch-rank { background: var(--slot-cut-stretch-rank); }
.actually-surfaced { position: absolute; top: 8px; right: 8px; background: var(--tag-actually-surfaced); color: white; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.body { padding: 14px 16px 16px; flex: 1; display: flex; flex-direction: column; }
.title { font-size: 14px; font-weight: 600; line-height: 1.35; margin-bottom: 6px; color: var(--fg); }
.title a { color: inherit; text-decoration: none; }
.title a:hover { color: var(--accent); }
.meta { color: var(--fg-muted); font-size: 12px; margin-bottom: 10px; }
.meta .channel { color: var(--fg); }
.scores { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.chip { background: var(--bg-elevated); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
.chip.conn { color: #a8c8a8; }
.chip.qual { color: #c8b8a8; }
.chip.fresh { color: #a8b8c8; }
.chip.weighted { background: var(--accent); color: #1a1916; font-weight: 600; }
.chip.interest { color: var(--fg-muted); }
.chip.ts-news { background: var(--tag-news); color: white; }
.chip.ts-evergreen { background: var(--tag-evergreen); color: white; }
.chip.ts-standard { color: var(--fg-muted); }
.dedup-partner { color: var(--fg-muted); font-size: 12px; margin-bottom: 10px; padding: 6px 10px; background: var(--bg-elevated); border-radius: 6px; border-left: 3px solid var(--slot-cut-dedup); }
.dedup-partner strong { color: var(--fg); font-weight: 600; }
.why { color: var(--fg-muted); font-size: 12px; line-height: 1.5; padding-top: 10px; border-top: 1px solid var(--border); margin-top: auto; }
.why em { color: var(--accent); font-style: normal; font-weight: 500; }
`;

function cardHtml(card: Card, dedupPartnerTitle: (id: string) => string | null): string {
  const r = card.row;
  const v = card.verdict;
  const conn = (r.connection_score ?? 0).toFixed(1);
  const qual = (r.quality_score ?? 0).toFixed(1);
  const slotClass = DISPOSITION_CLASS[v.disposition];
  const slotLabel = DISPOSITION_LABEL[v.disposition];

  const tsKey = (r.time_sensitivity ?? 'standard').toLowerCase();
  const tsClass = tsKey === 'news' ? 'ts-news' : tsKey === 'evergreen' ? 'ts-evergreen' : 'ts-standard';

  const thumb = r.thumbnail_url
    ? `<img src="${escapeHtml(r.thumbnail_url)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="thumb-fallback" style="display:none">no thumbnail</div>`
    : `<div class="thumb-fallback">no thumbnail</div>`;
  const dur = durationLabel(r.duration_secs);

  const stretchCardClass = v.disposition === 'stretch' ? ' stretch-card' : '';

  const dedupBlock = v.disposition === 'cut_dedup' && v.dedupedAgainst
    ? (() => {
        const partner = dedupPartnerTitle(v.dedupedAgainst!);
        return partner
          ? `<div class="dedup-partner"><strong>deduped against:</strong> ${escapeHtml(partner)}</div>`
          : '';
      })()
    : '';

  return `<div class="card${stretchCardClass}">
    <div class="thumb-wrap">
      ${thumb}
      <div class="slot-tag ${slotClass}">${escapeHtml(slotLabel)}</div>
      ${dur ? `<div class="duration">${escapeHtml(dur)}</div>` : ''}
    </div>
    <div class="body">
      <div class="title"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title ?? '(no title)')}</a></div>
      <div class="meta"><span class="channel">${escapeHtml(r.channel ?? 'unknown channel')}</span> · ${escapeHtml(ageLabel(r.published_at))}</div>
      <div class="scores">
        <span class="chip conn">conn ${conn}</span>
        <span class="chip qual">qual ${qual}</span>
        <span class="chip ${tsClass}">${escapeHtml(tsKey)}</span>
        <span class="chip fresh">×${v.fresh.toFixed(1)} fresh</span>
        <span class="chip weighted">${v.weighted.toFixed(1)}</span>
        ${r.interest_label ? `<span class="chip interest">${escapeHtml(r.interest_label)}${r.rank !== 999 ? ` · rank ${r.rank}` : ''}</span>` : ''}
      </div>
      ${dedupBlock}
      ${r.why_text ? `<div class="why"><em>why →</em> ${escapeHtml(r.why_text)}</div>` : ''}
    </div>
  </div>`;
}

export function renderPreviewHtml(targetArg: string | null): string {
  const allUsers = db.prepare(
    "SELECT user_id, role, age_gate, display_name FROM users WHERE role IN ('kid','parent') ORDER BY role, display_name"
  ).all() as UserRow[];

  const users = targetArg
    ? allUsers.filter((u) => u.user_id === targetArg || u.display_name.toLowerCase() === targetArg.toLowerCase())
    : allUsers;

  if (users.length === 0) {
    return `<!DOCTYPE html><html><body><h1>No matching user</h1><p>Argument: <code>${escapeHtml(targetArg ?? '')}</code></p></body></html>`;
  }

  const sections = users.map(buildSection);

  const tabs = allUsers.map((u) => {
    const active = users.length === 1 && u.user_id === users[0]!.user_id ? ' active' : '';
    return `<a href="?user=${encodeURIComponent(u.display_name)}" class="${active.trim()}">${escapeHtml(u.display_name)}</a>`;
  }).join('');
  const allActive = users.length === allUsers.length ? ' active' : '';

  const sectionsHtml = sections.map((s) => {
    const titleById = new Map(s.selected.concat(s.rest).map((c) => [c.row.candidate_id, c.row.title ?? '(no title)']));
    const lookup = (id: string): string | null => titleById.get(id) ?? null;
    return `
<div class="section">
  <h1>${escapeHtml(s.user.display_name)} <span style="color:var(--fg-muted);font-weight:400;font-size:14px">(${escapeHtml(s.user.role)})</span></h1>
  <div class="summary">
    Pool: <strong>${s.totals.pool}</strong> (eligible <strong>${s.totals.eligible}</strong>, rejected by floor <strong>${s.totals.rejected}</strong>) ·
    cap <strong>${s.totals.cap}</strong> · simulated selection <strong>${s.totals.selected}</strong>
  </div>
  ${s.selected.length > 0 ? `
    <h2>Simulated feed <span class="muted">— what the algorithm picks today (${s.selected.length}/${s.totals.cap})</span></h2>
    <div class="grid selected">${s.selected.map((c) => cardHtml(c, lookup)).join('')}</div>
  ` : `
    <h2>Simulated feed</h2>
    <p style="color:var(--fg-muted)">No eligible candidates pass the floor. Rescore or refresh the pool.</p>
  `}
  ${s.rest.length > 0 ? `
    <h2>Rest of pool <span class="muted">— ranked by weighted score (${s.rest.length})</span></h2>
    <div class="grid">${s.rest.map((c) => cardHtml(c, lookup)).join('')}</div>
  ` : ''}
</div>
`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eddy discovery preview</title><style>${css}</style></head>
<body>
<div class="toolbar">
  <strong style="color:var(--fg)">Discovery preview · simulated</strong>
  <a href="?" class="${allActive.trim()}">All</a>
  ${tabs}
</div>
${sectionsHtml}
</body></html>`;
}
