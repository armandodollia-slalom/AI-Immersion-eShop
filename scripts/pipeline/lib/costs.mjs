// Cost reports over .agent-metrics/token-usage.jsonl: one ticket itemized by pipeline stage, one epic
// itemized by ticket and stage, and the long-term overview by epic, stage, model and month.
import { listEpics } from './stories.mjs';
import { loadUsage } from './usage.mjs';

export const STAGE_ORDER = ['implement', 'implement-pair', 'implement-verify', 'implement-ui-verify', 'review', 'plan', 'plan-verify', 'automation', 'automation-verify', 'pr-check', 'lessons'];

const stageRank = (s) => (STAGE_ORDER.includes(s) ? STAGE_ORDER.indexOf(s) : STAGE_ORDER.length);
const byStage = (a, b) => stageRank(a.stage) - stageRank(b.stage) || a.stage.localeCompare(b.stage);

const groupBy = (items, key) =>
  items.reduce((map, item) => {
    (map[key(item) ?? '(none)'] ??= []).push(item);
    return map;
  }, {});

export function summarize(rows) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  let cliCost = 0;
  let cliComputed = 0;
  const cliRuns = new Set();
  let unpricedTokens = 0;
  // Copilot meters premium requests and AI credits (nano AIU; 1e11 nano AIU = $1, which matches the
  // API list price we compute), so its own figures are kept next to ours.
  let premium = 0;
  let nanoAiu = 0;
  let nanoComputed = 0;
  const premiumRuns = new Set();
  const nanoRuns = new Set();
  const runs = new Set();
  const unmeasured = new Set();
  const cacheHitRuns = new Set();
  const models = {};
  for (const r of rows) {
    runs.add(r.run_id);
    if (!r.measured) {
      unmeasured.add(r.run_id);
      continue;
    }
    const k = r.tokens;
    const write = (k.cache_write_5m ?? 0) + (k.cache_write_1h ?? 0);
    t.input += k.input;
    t.output += k.output;
    t.cacheRead += k.cache_read;
    t.cacheWrite += write;
    if (r.cache_hit) cacheHitRuns.add(r.run_id);
    const m = (models[r.model ?? 'unknown'] ??= { tokens: 0, costUsd: 0 });
    m.tokens += k.input + k.output + k.cache_read + write;
    if (r.cost_usd == null) unpricedTokens += k.input + k.output + k.cache_read + write;
    else {
      cost += r.cost_usd;
      m.costUsd += r.cost_usd;
    }
    if (r.premium_requests != null) {
      premium += r.premium_requests;
      premiumRuns.add(r.run_id);
    }
    if (r.nano_aiu != null) {
      nanoAiu += r.nano_aiu;
      nanoComputed += r.cost_usd ?? 0;
      nanoRuns.add(r.run_id);
    }
    if (r.cli_cost_usd != null) {
      cliCost += r.cli_cost_usd;
      cliComputed += r.cost_usd ?? 0;
      cliRuns.add(r.run_id);
    }
  }
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return {
    runs: runs.size,
    unmeasuredRuns: unmeasured.size,
    cacheHitRuns: cacheHitRuns.size,
    tokens: t,
    cacheHitRate: prompt ? round(t.cacheRead / prompt, 3) : 0,
    costUsd: round(cost, 6),
    cliCostUsd: cliRuns.size ? round(cliCost, 6) : null,
    cliCheck: cliRuns.size ? { runs: cliRuns.size, computedUsd: round(cliComputed, 6), reportedUsd: round(cliCost, 6) } : null,
    unpricedTokens,
    premiumRequests: premiumRuns.size ? round(premium, 3) : null,
    copilotCheck: nanoRuns.size ? { runs: nanoRuns.size, meteredUsd: round(nanoAiu / NANO_AIU_PER_USD, 6), computedUsd: round(nanoComputed, 6) } : null,
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { tokens: v.tokens, costUsd: round(v.costUsd, 6) }])),
  };
}

export const NANO_AIU_PER_USD = 1e11;

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

export function filterUsage(rows, { since } = {}) {
  return rows.filter((r) => !since || r.ts >= since);
}

// Rows recorded before a story was added to an epic file pick up its current epic.
function withEpics(config, rows) {
  const epics = listEpics(config);
  const current = (key) => epics.find((e) => e.stories.has(key))?.key ?? null;
  return { epics, rows: rows.map((r) => ({ ...r, epic: r.epic ?? (r.story ? current(r.story) : null) })) };
}

const stagesOf = (rows) =>
  Object.entries(groupBy(rows, (r) => r.stage))
    .map(([stage, list]) => ({ stage, ...summarize(list) }))
    .sort(byStage);

export function storyReport(config, key, { since, rows = loadUsage(config) } = {}) {
  const scoped = withEpics(config, filterUsage(rows, { since })).rows.filter((r) => r.story === key);
  return { story: key, epic: scoped.find((r) => r.epic)?.epic ?? null, stages: stagesOf(scoped), total: summarize(scoped) };
}

export function findEpic(config, needle) {
  const n = String(needle).toLowerCase().replace(/^epic-/, '').replace(/\.md$/, '');
  const epics = listEpics(config);
  return epics.find((e) => e.key === n) ?? epics.find((e) => e.key.includes(n) || e.title.toLowerCase().includes(n)) ?? null;
}

export function epicReport(config, epicKey, { since, rows = loadUsage(config) } = {}) {
  const { epics, rows: all } = withEpics(config, filterUsage(rows, { since }));
  const scoped = all.filter((r) => r.epic === epicKey);
  const stories = Object.entries(groupBy(scoped, (r) => r.story))
    .map(([story, list]) => ({ story, stages: stagesOf(list), total: summarize(list) }))
    .sort((a, b) => a.story.localeCompare(b.story, undefined, { numeric: true }));
  return { epic: epicKey, title: epics.find((e) => e.key === epicKey)?.title ?? epicKey, stories, stages: stagesOf(scoped), total: summarize(scoped) };
}

export function overviewReport(config, { since, rows = loadUsage(config) } = {}) {
  const { rows: all } = withEpics(config, filterUsage(rows, { since }));
  const by = (key) => Object.entries(groupBy(all, key)).map(([k, list]) => ({ key: k, ...summarize(list) }));
  return {
    since: since ?? null,
    epics: by((r) => r.epic).sort((a, b) => b.costUsd - a.costUsd),
    stories: by((r) => r.story).sort((a, b) => b.costUsd - a.costUsd),
    stages: by((r) => r.stage).map((s) => ({ ...s, stage: s.key })).sort(byStage),
    models: by((r) => r.model).sort((a, b) => b.costUsd - a.costUsd),
    months: by((r) => r.ts.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    total: summarize(all),
  };
}

export const usd = (n) => (n == null ? '-' : n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (n) => `${Math.round(n * 100)}%`;
const modelsOf = (s) => Object.keys(s.models).join(', ') || '-';

const COLUMNS = ['runs', 'input', 'output', 'cache read', 'cache write', 'cache hit', 'models', 'cost'];
const cells = (label, s) => [label, String(s.runs), tok(s.tokens.input), tok(s.tokens.output), tok(s.tokens.cacheRead), tok(s.tokens.cacheWrite), `${pct(s.cacheHitRate)} (${s.cacheHitRuns}/${s.runs - s.unmeasuredRuns} runs)`, modelsOf(s), usd(s.costUsd)];

function table(head, rows, markdown) {
  const all = [[head, ...COLUMNS], ...rows];
  if (markdown) return [`| ${all[0].join(' | ')} |`, `|${all[0].map((_, i) => (i === 0 || i === 7 ? ' --- ' : ' ---: ')).join('|')}|`, ...all.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n');
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => (i === 0 || i === 7 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd()).join('\n');
}

function notes(total) {
  const out = [];
  if (total.unmeasuredRuns) out.push(`${total.unmeasuredRuns} run(s) reported no token usage (timed out, crashed, or a custom agent command) and are not in the totals.`);
  if (total.unpricedTokens) out.push(`${tok(total.unpricedTokens)} token(s) are on models without a price in scripts/pipeline/pricing.json and are not in the cost.`);
  const c = total.cliCheck;
  if (c) out.push(`Check: ${c.runs} run(s) also report a cost from the agent CLI: ${usd(c.reportedUsd)} reported, ${usd(c.computedUsd)} computed from pricing.json.`);
  if (total.premiumRequests != null) out.push(`Copilot premium requests: ${total.premiumRequests} (what a Copilot plan bills against its monthly allowance).`);
  const p = total.copilotCheck;
  if (p) out.push(`Copilot metering: ${p.runs} run(s) report AI credits worth ${usd(p.meteredUsd)}; ${usd(p.computedUsd)} computed from pricing.json.`);
  return out;
}

export function formatStory(report, { markdown = false } = {}) {
  const title = `${report.story}${report.epic ? ` (epic: ${report.epic})` : ''}`;
  if (!report.total.runs) return `${title}: no agent runs recorded.`;
  const body = table('stage', [...report.stages.map((s) => cells(s.stage, s)), cells('TOTAL', report.total)], markdown);
  return [markdown ? `### Agent token cost: ${title}` : `Agent token cost: ${title}`, '', body, ...notes(report.total).map((n) => (markdown ? `\n_${n}_` : n))].join('\n');
}

export function formatEpic(report, { markdown = false } = {}) {
  const out = [markdown ? `### Agent token cost: epic ${report.title}` : `Agent token cost: epic ${report.title} (${report.epic})`, ''];
  if (!report.total.runs) return `${out[0]}: no agent runs recorded.`;
  out.push(table('ticket', [...report.stories.map((s) => cells(s.story, s.total)), cells('TOTAL', report.total)], markdown));
  out.push('', markdown ? '#### By stage' : 'By stage', '', table('stage', [...report.stages.map((s) => cells(s.stage, s)), cells('TOTAL', report.total)], markdown));
  for (const s of report.stories) out.push('', markdown ? `#### ${s.story}` : s.story, '', table('stage', [...s.stages.map((x) => cells(x.stage, x)), cells('TOTAL', s.total)], markdown));
  out.push(...notes(report.total).map((n) => `\n${n}`));
  return out.join('\n');
}

export function formatOverview(report, { markdown = false } = {}) {
  const section = (title, head, list) => ['', markdown ? `#### ${title}` : title, '', table(head, [...list.map((s) => cells(s.key, s)), cells('TOTAL', report.total)], markdown)];
  if (!report.total.runs) return 'No agent runs recorded.';
  return [
    markdown ? `### Agent token cost${report.since ? ` since ${report.since}` : ''}` : `Agent token cost${report.since ? ` since ${report.since}` : ''}`,
    ...section('By epic', 'epic', report.epics),
    ...section('By ticket', 'ticket', report.stories),
    ...section('By stage', 'stage', report.stages),
    ...section('By model', 'model', report.models),
    ...section('By month', 'month', report.months),
    ...notes(report.total).map((n) => `\n${n}`),
  ].join('\n');
}
