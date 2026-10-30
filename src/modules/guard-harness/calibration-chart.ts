// The calibration report as one self-contained HTML page of SVG charts: the
// reliability of p_over, and clear-yes precision and uncertain rate against τ.
// Aggregate numbers only — no item ids, titles, channels or reasons
// (ADR-0004). Written beside the DB, mode 0600.
import { chmodSync, writeFileSync } from 'node:fs';
import { meetsTargets, type CalibrationPoint, type CalibrationReport } from './calibrate';
import { THRESHOLDS } from './util';

const W = 520;
const H = 300;
const M = { top: 52, right: 20, bottom: 62, left: 58 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const COLOUR = {
  ink: '#1d2430',
  grid: '#e3e7ee',
  muted: '#6b7484',
  primary: '#2f6fdb',
  secondary: '#d9822b',
  target: '#2e9d5b',
  baseline: '#8a5cc7',
  holdout: '#c43d4b',
  cap: '#b8860b',
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const pct = (v: number | null, dp = 1): string => (v === null ? 'n/a' : `${(v * 100).toFixed(dp)}%`);
const fmt = (n: number): string => Number(n.toFixed(4)).toString();

interface Axis {
  min: number;
  max: number;
  ticks: number[];
}

function linear(axis: Axis, size: number, flip: boolean) {
  return (v: number): number => {
    const t = (v - axis.min) / (axis.max - axis.min);
    return Number((flip ? size - t * size : t * size).toFixed(1));
  };
}

function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max + step / 1000; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function frame(title: string, xLabel: string, yLabel: string, legendRow: string, body: string): string {
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
  <text x="${M.left}" y="18" class="title">${esc(title)}</text>
  <g transform="translate(${M.left},34)">${legendRow}</g>
  <g transform="translate(${M.left},${M.top})">${body}</g>
  <text x="${M.left + PW / 2}" y="${H - 8}" class="axis-label" text-anchor="middle">${esc(xLabel)}</text>
  <text transform="translate(16,${M.top + PH / 2}) rotate(-90)" class="axis-label" text-anchor="middle">${esc(yLabel)}</text>
</svg>`;
}

function yGrid(axis: Axis, y: (v: number) => number, label: (v: number) => string): string {
  return axis.ticks.map((t) => `<line x1="0" x2="${PW}" y1="${y(t)}" y2="${y(t)}" stroke="${COLOUR.grid}"/>`
    + `<text x="-8" y="${y(t) + 4}" class="tick" text-anchor="end">${esc(label(t))}</text>`).join('');
}

function xTicks(axis: Axis, x: (v: number) => number, label: (v: number) => string): string {
  return axis.ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${PH}" y2="${PH + 5}" stroke="${COLOUR.muted}"/>`
    + `<text x="${x(t)}" y="${PH + 18}" class="tick" text-anchor="middle">${esc(label(t))}</text>`).join('')
    + `<line x1="0" x2="${PW}" y1="${PH}" y2="${PH}" stroke="${COLOUR.muted}"/>`;
}

// A horizontal reference line, labelled above it at the left end or below it
// at the right, so two lines close together don't collide.
function hLine(y: number, colour: string, label: string, dashed: boolean, anchor: 'start' | 'end'): string {
  const text = anchor === 'start'
    ? `<text x="4" y="${y - 5}" class="note" fill="${colour}">${esc(label)}</text>`
    : `<text x="${PW - 4}" y="${Math.min(PH - 4, y + 14)}" class="note" text-anchor="end" fill="${colour}">${esc(label)}</text>`;
  return `<line x1="0" x2="${PW}" y1="${y}" y2="${y}" stroke="${colour}" stroke-width="1.5"${dashed ? ' stroke-dasharray="5 4"' : ''}/>${text}`;
}

type Mark = 'line' | 'dash' | 'bar' | 'dot' | 'diamond';

function mark(kind: Mark, colour: string): string {
  switch (kind) {
    case 'line':
    case 'dash':
      return `<line x1="0" x2="22" y1="0" y2="0" stroke="${colour}" stroke-width="2"${kind === 'dash' ? ' stroke-dasharray="5 4"' : ''}/>`;
    case 'bar':
      return `<rect x="4" y="-6" width="14" height="12" fill="${colour}" opacity="0.75"/>`;
    case 'dot':
      return `<circle cx="11" cy="0" r="4.5" fill="${colour}"/>`;
    case 'diamond':
      return `<rect x="7" y="-4" width="8" height="8" fill="${colour}" transform="rotate(45 11 0)"/>`;
  }
}

// One row of legend entries, left to right in the top margin.
function legendRow(entries: Array<[string, string, Mark]>): string {
  let x = 0;
  return entries.map(([label, colour, kind]) => {
    const out = `<g transform="translate(${x},0)">${mark(kind, colour)}<text x="28" y="4" class="note">${esc(label)}</text></g>`;
    x += 28 + Math.ceil(label.length * 6.2) + 16;
    return out;
  }).join('');
}

// Reliability: per p_over bin, the observed Unsafe rate among clear_yes items
// (bar, Wilson 95% interval) against the bin's mean p_over (dot); n under
// each bin.
function reliabilityChart(r: CalibrationReport): string {
  const bins = r.reliability;
  const top = Math.max(0.2, ...bins.map((b) => b.interval?.high ?? 0), ...bins.map((b) => b.meanPOver ?? 0));
  const yMax = Math.min(1, Math.ceil(top * 10) / 10);
  const axis: Axis = { min: 0, max: yMax, ticks: ticks(0, yMax, yMax <= 0.5 ? 0.1 : 0.2) };
  const y = linear(axis, PH, true);
  const slot = PW / bins.length;
  const bars = bins.map((b, i) => {
    const cx = Number((slot * i + slot / 2).toFixed(1));
    const half = Number((slot * 0.3).toFixed(1));
    let out = `<text x="${cx}" y="${PH + 18}" class="tick" text-anchor="middle">${esc(`${fmt(b.low)}–${fmt(b.high)}`)}</text>`
      + `<text x="${cx}" y="${PH + 33}" class="tick" text-anchor="middle">n=${b.n}</text>`;
    if (b.rate !== null) {
      out += `<rect x="${cx - half}" y="${y(b.rate)}" width="${half * 2}" height="${Number((PH - y(b.rate)).toFixed(1))}" fill="${COLOUR.primary}" opacity="0.75"/>`;
    }
    if (b.interval) {
      const lo = y(b.interval.low);
      const hi = y(b.interval.high);
      out += `<line x1="${cx}" x2="${cx}" y1="${lo}" y2="${hi}" stroke="${COLOUR.ink}"/>`
        + `<line x1="${cx - 5}" x2="${cx + 5}" y1="${hi}" y2="${hi}" stroke="${COLOUR.ink}"/>`
        + `<line x1="${cx - 5}" x2="${cx + 5}" y1="${lo}" y2="${lo}" stroke="${COLOUR.ink}"/>`;
    }
    if (b.meanPOver !== null) {
      out += `<circle cx="${cx}" cy="${y(b.meanPOver)}" r="4.5" fill="${COLOUR.secondary}" stroke="#fff"/>`;
    }
    return out;
  }).join('');
  const body = yGrid(axis, y, (v) => pct(v, 0))
    + `<line x1="0" x2="${PW}" y1="${PH}" y2="${PH}" stroke="${COLOUR.muted}"/>`
    + bars;
  const legend = legendRow([
    ['observed Unsafe rate (95% CI)', COLOUR.primary, 'bar'],
    ['mean p_over in bin', COLOUR.secondary, 'dot'],
  ]);
  return frame('Reliability: p_over against the observed Unsafe rate', 'p_over bin (non-holdout items the plain verdict cleared)', 'Unsafe rate', legend, body);
}

interface Series {
  colour: string;
  value: (p: CalibrationPoint) => number | null;
}

function sweepChart(
  r: CalibrationReport,
  title: string,
  yLabel: string,
  series: Series,
  axis: Axis,
  targets: Array<[number, string]>,
  baselineValue: number | null,
  holdoutValue: number | null,
  cap: number | null = null,
): string {
  const tauMax = Math.max(...r.sweep.map((p) => p.tau ?? 0), 0.5);
  const xAxis: Axis = { min: 0, max: tauMax, ticks: ticks(0, tauMax, 0.1) };
  const x = linear(xAxis, PW, false);
  const y = linear(axis, PH, true);
  const clamp = (v: number) => Math.max(axis.min, Math.min(axis.max, v));
  const pts = r.sweep
    .map((p) => [p.tau, series.value(p)] as const)
    .filter((pv): pv is readonly [number, number] => pv[0] !== null && pv[1] !== null);
  const path = pts.map(([t, v], i) => `${i === 0 ? 'M' : 'L'}${x(t)},${y(clamp(v))}`).join(' ');
  let body = yGrid(axis, y, (v) => pct(v, 0)) + xTicks(xAxis, x, (v) => fmt(v));
  for (const [v, label] of targets) body += hLine(y(v), COLOUR.target, label, false, 'start');
  if (cap !== null) body += hLine(y(clamp(cap)), COLOUR.cap, `cap ${pct(cap, 0)} (picks τ*)`, true, 'end');
  if (baselineValue !== null) {
    body += hLine(y(clamp(baselineValue)), COLOUR.baseline, `incumbent ${pct(baselineValue)}`, true, 'end');
  }
  body += `<path d="${path}" fill="none" stroke="${series.colour}" stroke-width="2.2"/>`
    + pts.map(([t, v]) => `<circle cx="${x(t)}" cy="${y(clamp(v))}" r="3" fill="${series.colour}"/>`).join('');
  const entries: Array<[string, string, Mark]> = [
    ['non-holdout', series.colour, 'line'],
    ['incumbent', COLOUR.baseline, 'dash'],
    ['target (reference)', COLOUR.target, 'line'],
  ];
  if (cap !== null) entries.push(['cap', COLOUR.cap, 'dash']);
  if (r.tauStar !== null) {
    const tx = x(r.tauStar);
    body += `<line x1="${tx}" x2="${tx}" y1="0" y2="${PH}" stroke="${COLOUR.ink}" stroke-dasharray="2 3"/>`
      + `<text x="${tx + 4}" y="12" class="note">τ* = ${fmt(r.tauStar)}</text>`;
    if (holdoutValue !== null) {
      const hy = y(clamp(holdoutValue));
      body += `<rect x="${tx - 5}" y="${hy - 5}" width="10" height="10" fill="${COLOUR.holdout}" transform="rotate(45 ${tx} ${hy})"/>`;
      entries.push(['holdout at τ*', COLOUR.holdout, 'diamond']);
    }
  }
  return frame(title, 'τ: a clear_yes with p_over ≥ τ is escalated', yLabel, legendRow(entries), body);
}

function row(name: string, p: CalibrationPoint | null): string {
  if (!p) return `<tr><td>${esc(name)}</td><td colspan="4">n/a</td></tr>`;
  const ci = p.intervals.clearYesPrecision;
  return `<tr><td>${esc(name)}</td><td>${p.metrics.total}</td>`
    + `<td>${pct(p.metrics.clearYesPrecision)}${ci ? ` <span class="ci">[${pct(ci.low)}, ${pct(ci.high)}]</span>` : ''}</td>`
    + `<td>${p.unsafePassed} / ${p.unsafeTotal}</td><td>${pct(p.metrics.uncertainRate)}</td></tr>`;
}

export function calibrationChartHtml(r: CalibrationReport, datasetName: string, generatedAt: Date): string {
  // Axis ranges cover every value plotted — the sweep, the incumbent line
  // and the holdout point — so nothing is clamped into view.
  const known = (vs: Array<number | null | undefined>): number[] => vs.filter((v): v is number => v !== null && v !== undefined);
  const baselineP = r.baseline?.nonHoldout.metrics.clearYesPrecision ?? null;
  const holdoutP = r.holdoutAtTauStar?.metrics.clearYesPrecision ?? null;
  const precisions = known([...r.sweep.map((p) => p.metrics.clearYesPrecision), baselineP, holdoutP]);
  const precisionAxisMin = Math.max(0, Math.floor(Math.min(0.9, ...precisions) * 20) / 20);
  const precisionStep = 1 - precisionAxisMin > 0.3 ? 0.1 : 0.05;
  const precisionAxis: Axis = { min: precisionAxisMin, max: 1, ticks: ticks(precisionAxisMin, 1, precisionStep) };
  // The uncertain chart plots the projected live rate the cap applies to, with
  // today's live rate as the incumbent line. The holdout's labelled rate is in
  // the table; it isn't on this scale.
  const liveU = r.live && r.live.total > 0 ? r.live.uncertain / r.live.total : null;
  const uncertain = known([...r.sweep.map((p) => p.projectedUncertainRate), liveU, r.uncertainCap]);
  const uMax = Math.min(1, Math.ceil(Math.max(0.5, ...uncertain) * 10) / 10);
  const uncertainAxis: Axis = { min: 0, max: uMax, ticks: ticks(0, uMax, uMax > 0.6 ? 0.2 : 0.1) };
  const t = THRESHOLDS;

  const precisionChart = sweepChart(
    r, 'Clear-yes precision against τ', 'clear-yes precision',
    { colour: COLOUR.primary, value: (p) => p.metrics.clearYesPrecision },
    precisionAxis, [[t.clearYesPrecision, `target ≥ ${t.clearYesPrecision * 100}%`]],
    baselineP, holdoutP,
  );
  const uncertainChart = sweepChart(
    r, 'Projected live uncertain rate against τ', 'projected live uncertain rate',
    { colour: COLOUR.secondary, value: (p) => p.projectedUncertainRate },
    uncertainAxis, [[t.uncertainRate.max, `ceiling ${t.uncertainRate.max * 100}%`], [t.uncertainRate.min, `floor ${t.uncertainRate.min * 100}%`]],
    liveU, null, r.uncertainCap,
  );

  const cap = pct(r.uncertainCap, 0);
  const rule = `Rule (pre-registered, non-holdout only): of the τ whose projected live uncertain rate is at most ${cap}, take the fewest Unsafe passed as clear-yes; τ* is the loosest τ reaching that minimum. The targets (clear-yes ≥ ${t.clearYesPrecision * 100}%, uncertain ${t.uncertainRate.min * 100}–${t.uncertainRate.max * 100}%) are shown for reference and don't pick τ*.`;
  let verdict: string;
  if (r.tauStar === null) {
    verdict = `No τ on the grid keeps the projected live uncertain rate at or under ${cap}, so there is no τ*.`;
  } else {
    const atStar = r.sweep.find((p) => p.tau === r.tauStar);
    const met = atStar ? meetsTargets(atStar) : null;
    const yesNo = (ok: boolean | undefined) => (ok ? 'met' : 'not met');
    verdict = `τ* = ${fmt(r.tauStar)}: ${r.minUnsafePassed} Unsafe passed on the non-holdout items. `
      + `For reference: clear-yes ≥ ${t.clearYesPrecision * 100}% ${yesNo(met?.clearYesPrecision)}, `
      + `uncertain ${t.uncertainRate.min * 100}–${t.uncertainRate.max * 100}% ${yesNo(met?.uncertainRate)}. The holdout rows are the honest test.`;
  }

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>Guard calibration — ${esc(datasetName)}</title>
<style>
  body { font: 14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: ${COLOUR.ink}; margin: 32px auto; max-width: 1100px; padding: 0 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: ${COLOUR.muted}; margin: 0 0 20px; }
  .charts { display: flex; flex-wrap: wrap; gap: 16px; }
  svg { background: #fff; border: 1px solid ${COLOUR.grid}; border-radius: 6px; }
  svg .title { font-size: 14px; font-weight: 600; fill: ${COLOUR.ink}; }
  svg .tick { font-size: 11px; fill: ${COLOUR.muted}; }
  svg .axis-label { font-size: 12px; fill: ${COLOUR.ink}; }
  svg .note { font-size: 11px; fill: ${COLOUR.ink}; }
  table { border-collapse: collapse; margin: 8px 0 20px; }
  th, td { padding: 4px 12px; border-bottom: 1px solid ${COLOUR.grid}; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  .ci { color: ${COLOUR.muted}; font-size: 12px; }
  p.method { color: ${COLOUR.muted}; max-width: 900px; }
</style>
</head>
<body>
<h1>Guard calibration: score probabilities against parent safety labels</h1>
<p class="sub">${esc(datasetName)} · adapter ${esc(r.adapterId)} · generated ${esc(generatedAt.toISOString().slice(0, 10))}</p>
<p>${esc(rule)}</p>
<p>${esc(verdict)}</p>
<table>
<thead><tr><th>verdicts</th><th>n</th><th>clear-yes precision (95% CI)</th><th>Unsafe passed as clear-yes</th><th>uncertain rate (labelled items)</th></tr></thead>
<tbody>
${row('incumbent, non-holdout', r.baseline?.nonHoldout ?? null)}
${row('plain verdict, non-holdout', r.plain.nonHoldout)}
${row(r.tauStar !== null ? `τ* = ${fmt(r.tauStar)}, non-holdout` : 'τ*, non-holdout', r.tauStar !== null ? r.sweep.find((p) => p.tau === r.tauStar) ?? null : null)}
${row('incumbent, holdout', r.baseline?.holdout ?? null)}
${row('plain verdict, holdout', r.plain.holdout)}
${row(r.tauStar !== null ? `τ* = ${fmt(r.tauStar)}, holdout (honest test)` : 'τ*, holdout', r.holdoutAtTauStar)}
</tbody>
</table>
<div class="charts">
${precisionChart}
${uncertainChart}
${reliabilityChart(r)}
</div>
<p class="method">p_over is the largest probability, over the eight rubric dimensions, that the model's score is above the item's age-band limit, read from the score digit's token probabilities and renormalised over 0–3. A clear_yes becomes uncertain when p_over ≥ τ or a dimension's probabilities could not be read; nothing else changes, so the calibrated verdict is never looser than the plain one. Safety labels only: Allow is clear-yes, Unsafe is clear-no; Not for us and unrecorded Blocks are left out. τ* is chosen on the non-holdout items by the rule above and tested once on the holdout. The cap applies to a projected live uncertain rate, not to the labelled items' rate, because every escalation is decided while clear verdicts are only sampled: the live candidate prompt's uncertain share over the last 14 days, plus its clear-yes share times the fraction of audited clear-yes items (live and replayed clear_yes, non-holdout) that τ escalates${r.live ? ` (${r.live.uncertain} uncertain and ${r.live.clearYes} clear-yes of ${r.live.total} live verdicts; ${r.auditedClearYes} audited items)` : ''}. Aggregate counts only.</p>
</body>
</html>
`;
}

export function writeCalibrationChart(file: string, html: string): void {
  writeFileSync(file, html, { mode: 0o600 });
  // writeFileSync's mode applies only on create; an older chart keeps its own.
  chmodSync(file, 0o600);
}
