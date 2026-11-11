// Cost & waste dashboards over .agent-metrics: one self-contained HTML page for an epic run (tokens, cost,
// human time at an hourly rate, waste from rework and model/CLI hand-offs, PR-check escalation, cost per
// heal) and one with a page per story. Metrics are read from the working tree, the epic's branches and
// their worktrees, de-duplicated, and rendered into scripts/pipeline/dashboard/*.html. `--publish` pushes
// each page to a GitHub Pages repository. See docs/ai-pipeline/costs.md#dashboards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PIPELINE_DIR } from './config.mjs';
import { epicTickets, listEpics, loadTicket, ticketText } from './tickets.mjs';
import { listEscalations } from './state.mjs';
import { log, nowIso, run } from './util.mjs';

export const METRIC_FILES = ['token-usage', 'verifier-runs', 'verifier-denials', 'subtask-runs', 'implement-runs', 'pr-checks', 'precheck-failures'];
export const TEMPLATES = { epic: path.join(PIPELINE_DIR, 'dashboard', 'epic.html'), story: path.join(PIPELINE_DIR, 'dashboard', 'story.html') };
const DEFAULTS = { rate: 220, timeZone: 'America/Chicago', tzLabel: 'CST', idleGapMin: 30, out: 'artifacts/dashboards', pages: {} };

export const dashboardConfig = (config) => ({ ...DEFAULTS, ...(config.dashboard ?? {}) });

const parseLines = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

const shortRef = (ref) => ref.replace(/^refs\/(remotes\/origin|heads)\//, '');

// Git refs that hold an epic's metrics: its epic branch and its bug-group branches, local and on origin.
export function epicRefs(config, slug) {
  const epicPrefix = config.implement?.epic?.branchPrefix ?? 'epic/';
  const bugPrefix = config.implement?.epic?.bugfixPrefix ?? 'bugfix/';
  const patterns = [`${epicPrefix}${slug}`, `${bugPrefix}${slug}/*`].flatMap((p) => [`refs/heads/${p}`, `refs/remotes/origin/${p}`]);
  const res = run('git', ['for-each-ref', '--format=%(refname)', ...patterns], { cwd: config.root });
  return res.stdout.split(/\r?\n/).filter(Boolean);
}

// Every metric row from the working tree, the given refs and the worktrees checked out on them (live,
// uncommitted rows). Each row is tagged with the branch it came from.
export function loadSources(config, refs = []) {
  const dir = config.metricsDir ?? '.agent-metrics';
  const files = Object.fromEntries(METRIC_FILES.map((f) => [f, []]));
  const add = (src, f, text) => files[f].push(...parseLines(text).map((r) => ({ ...r, _src: src })));
  const fromDir = (src, root) => {
    for (const f of METRIC_FILES) {
      const file = path.join(root, dir, `${f}.jsonl`);
      if (fs.existsSync(file)) add(src, f, fs.readFileSync(file, 'utf8'));
    }
  };
  fromDir('(working tree)', config.root);
  const branches = new Set(refs.map(shortRef));
  for (const ref of refs) for (const f of METRIC_FILES) add(shortRef(ref), f, run('git', ['show', `${ref}:${dir}/${f}.jsonl`], { cwd: config.root }).stdout);
  const wt = run('git', ['worktree', 'list', '--porcelain'], { cwd: config.root }).stdout.split(/\r?\n\r?\n/);
  for (const block of wt) {
    const wpath = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (wpath && branch && branches.has(branch) && path.resolve(wpath) !== path.resolve(config.root) && fs.existsSync(wpath)) fromDir(branch, wpath);
  }
  return { files, sources: [...branches] };
}

// Local wall-clock minutes since midnight of `baseDay` (so a run past midnight keeps counting up).
export function localClock(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (ts) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { day: Date.UTC(+p.year, +p.month - 1, +p.day) / 864e5, min: +p.hour * 60 + +p.minute + +p.second / 60 };
  };
}

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const tierOf = (model) => (/opus/i.test(model ?? '') ? 'opus' : 'sonnet');
const tokensOf = (k) => (k = k ?? {}, (k.input ?? 0) + (k.output ?? 0) + (k.cache_read ?? 0) + (k.cache_write_5m ?? 0) + (k.cache_write_1h ?? 0));
const acc = () => ({ runs: 0, tokens: 0, cost: 0, sec: 0 });
const addRun = (a, r) => {
  a.runs += 1;
  a.tokens += r.tokens;
  a.cost += r.cost;
  a.sec += r.sec;
  return a;
};
const fin = (a) => ({ ...a, cost: r4(a.cost) });
const uniq = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];

// Agent runs from token-usage rows: one per run_id (a run on two models has two rows), times in local
// minutes. Run start = end ts - seconds.
export function buildRuns(rows, clock, baseDay) {
  const byRun = new Map();
  for (const r of uniq(rows, (r) => `${r.run_id}|${r.model}`)) {
    const cost = r.cost_usd ?? 0;
    const cur = byRun.get(r.run_id);
    if (cur) {
      cur.tokens += tokensOf(r.tokens);
      cur.cost += cost;
      for (const k of Object.keys(cur.bd)) cur.bd[k] += r.tokens?.[k] ?? 0;
      if (cost > cur.topCost) Object.assign(cur, { topCost: cost, tier: tierOf(r.model) });
      continue;
    }
    const c = clock(r.ts);
    const end = (c.day - baseDay) * 1440 + c.min;
    const sec = r.seconds ?? 0;
    byRun.set(r.run_id, {
      id: r.run_id, story: r.story ?? null, epic: r.epic ?? null, stage: r.stage ?? 'other', agent: r.agent ?? '', cli: r.cli ?? 'unknown',
      round: r.round ?? 1, ok: r.ok !== false && !r.timed_out, sec, start: end - sec / 60, end, tier: tierOf(r.model), topCost: cost,
      tokens: tokensOf(r.tokens), cost, premium: r.premium_requests ?? 0, src: r._src,
      bd: Object.fromEntries(['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'].map((k) => [k, r.tokens?.[k] ?? 0])),
    });
  }
  return [...byRun.values()].sort((a, b) => a.start - b.start);
}

// Gaps of at least `minGap` minutes without a successful agent run (failed runs and timeouts can span
// them). A gap after which the agent CLI changed is an outage (quota, provider down); any other gap is
// idle time (host asleep, waiting on a human).
export function detectBands(runs, { minGap = 30 } = {}) {
  const ok = runs.filter((r) => r.ok).sort((a, b) => a.start - b.start);
  const bands = [];
  let reach = -Infinity;
  for (let i = 0; i < ok.length; i++) {
    const r = ok[i];
    if (i && r.start - reach >= minGap) {
      const cliBefore = new Set(ok.filter((x) => x.end <= reach + 1e-6 && x.end >= reach - 20).map((x) => x.cli));
      const after = ok.slice(i, i + 5);
      const switched = after.every((x) => !cliBefore.has(x.cli));
      bands.push({ a: reach, b: r.start, kind: switched ? 'outage' : 'idle', label: switched ? `${[...cliBefore].join('+')} out \u2192 ${after[0].cli}` : 'idle / host asleep' });
    }
    reach = Math.max(reach, r.end);
  }
  return bands;
}

// Waste: rework rounds (by model tier), runs repeated on another CLI after a switch, and failed runs.
export function classifyWaste(runs) {
  const laterCli = (r) => runs.some((x) => x.story === r.story && x.stage === r.stage && x.cli !== r.cli && x.start > r.start);
  const w = { sonnet: acc(), opus: acc(), switch: acc(), failed: acc() };
  const pairs = {};
  for (const r of runs) {
    if (!r.ok) addRun(w.failed, r);
    else if (r.round > 1) addRun(w[r.tier], r);
    else if (r.stage !== 'pr-check' && laterCli(r)) {
      addRun(w.switch, r);
      const to = runs.find((x) => x.story === r.story && x.stage === r.stage && x.cli !== r.cli && x.start > r.start).cli;
      pairs[`${r.cli}→${to}`] = (pairs[`${r.cli}→${to}`] ?? 0) + 1;
    }
  }
  return { waste: Object.fromEntries(Object.entries(w).map(([k, v]) => [k, fin(v)])), pairs };
}

const tuple = (r) => [r4(r.start), r.sec, r.stage, r.tier, r.ok, r.round, r4(r.cost), r.tokens, r.cli, r.agent];
const sumBy = (runs, key) => {
  const out = {};
  for (const r of runs) addRun((out[key(r)] ??= acc()), r);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, fin(v)]));
};
const breakdown = (runs) => runs.reduce((a, r) => (Object.keys(r.bd).forEach((k) => (a[k] = (a[k] ?? 0) + r.bd[k])), a), {});
const keyNum = (k) => Number(String(k).split('-').pop()) || 0;
const byKey = (a, b) => (a.split('-')[0] === b.split('-')[0] ? keyNum(a) - keyNum(b) : a.localeCompare(b));

const prRows = (rows) =>
  uniq(rows, (r) => `${r.ts}|${r.target}|${r.round}`).map((p) => ({
    target: p.target ?? p.story, stories: p.stories ?? [p.story], round: p.round, score: p.score, raised: p.raised ?? 0, lens: p.lensScores ?? {},
    upheld: (p.upheld ?? []).map((u) => ({ sev: u.severity, lens: u.lens, title: u.title })),
  }));

// The dashboard data both templates render. `meta` lists the stories in scope ({ key, title, issue,
// svc, note }); stories without runs show as blocked/not started with their note.
export function buildDashboard(rawFiles, { meta = [], scope = null, title, links = [], repoUrl = null, timeZone = DEFAULTS.timeZone, tzLabel = DEFAULTS.tzLabel, idleGapMin = DEFAULTS.idleGapMin, rate = DEFAULTS.rate, generatedAt = nowIso() } = {}) {
  const files = Object.fromEntries(METRIC_FILES.map((f) => [f, rawFiles[f] ?? []]));
  const keys = new Set(meta.map((m) => m.key));
  const inScope = (r) => !scope || keys.has(r.story) || (r.stories ?? []).some((k) => keys.has(k)) || (scope.epic && r.epic === scope.epic);
  const usage = files['token-usage'].filter(inScope);
  if (!usage.length) throw new Error('No agent runs recorded for this scope.');
  const clock = localClock(timeZone);
  const baseDay = Math.min(...usage.map((r) => clock(r.ts).day));
  const runs = buildRuns(usage, clock, baseDay);
  for (const k of new Set(runs.map((r) => r.story).filter(Boolean))) if (!keys.has(k)) meta.push({ key: k, title: k });
  const bands = detectBands(runs, { minGap: idleGapMin });
  const { waste, pairs } = classifyWaste(runs);
  const stamp = (rows) => uniq(rows.filter(inScope), (r) => JSON.stringify({ ...r, _src: undefined }));
  const ver = stamp(files['verifier-runs']).sort((a, b) => a.ts.localeCompare(b.ts));
  const den = stamp(files['verifier-denials']);
  const pre = stamp(files['precheck-failures']);
  const sub = stamp(files['subtask-runs']);
  const prc = prRows(files['pr-checks'].filter(inScope));
  const escalated = new Set(scope?.escalations ?? []);
  const storiesOn = (src) => new Set(runs.filter((r) => r.src === src).map((r) => r.story)).size;

  const stories = meta
    .sort((a, b) => byKey(a.key, b.key))
    .map((m) => {
      const sr = runs.filter((r) => r.story === m.key);
      const base = { k: m.key, issue: m.issue ?? null, title: String(m.title ?? m.key).replace(new RegExp(`^${m.key}\\s*[:\\-–]\\s*`), ''), svc: m.svc ?? '' };
      if (!sr.length) {
        const blockers = (m.blockedBy ?? []).filter((b) => keys.has(b));
        const note = m.note ?? ([...escalated].some((e) => e.startsWith(`${m.key}-`)) ? 'Escalated to a human' : blockers.length ? `Waiting on ${blockers.join(', ')}` : 'No agent runs yet');
        return { ...base, status: 'blocked', note };
      }
      const srcCount = sr.reduce((a, r) => ((a[r.src] = (a[r.src] ?? 0) + 1), a), {});
      // A story's rows also reach the branches it was merged into: prefer the branch with the fewest stories.
      const branch = Object.entries(srcCount).sort((a, b) => b[1] - a[1] || storiesOn(a[0]) - storiesOn(b[0]))[0][0];
      const sv = ver.filter((v) => v.story === m.key);
      const status = sv.some((v) => v.stage === 'automation' && v.passed) ? 'verified' : sr.some((r) => ['plan', 'automation'].includes(r.stage)) ? 'in-qe' : 'implementing';
      return {
        ...base, status, branch, pr: m.prs?.[branch]?.number ?? null, prUrl: m.prs?.[branch]?.url ?? null,
        all: fin(sr.reduce(addRun, acc())), opus: fin(sr.filter((r) => r.tier === 'opus').reduce(addRun, acc())), sonnet: fin(sr.filter((r) => r.tier !== 'opus').reduce(addRun, acc())),
        cli: sumBy(sr, (r) => r.cli), stages: sumBy(sr, (r) => r.stage), bd: breakdown(sr),
        start: r4(Math.min(...sr.map((r) => r.start))), end: r4(Math.max(...sr.map((r) => r.end))),
        runs: sr.map(tuple), waste: classifyWaste(sr).waste,
        verifiers: sv.map((v) => ({ stage: v.stage, round: v.round, score: v.score, passed: v.passed, gaps: v.gaps ?? 0 })),
        denials: den.filter((d) => d.story === m.key).map((d) => ({ stage: d.stage, round: d.round, agent: d.attributed_agent ?? '', cat: d.category ?? '', case: d.case ?? null, detail: d.detail ?? '' })),
        precheck: pre.filter((p) => p.story === m.key).map((p) => ({ stage: p.stage, round: p.round, errors: (p.errors ?? []).map((e) => String(e).slice(0, 400)) })),
        subtasks: sub.filter((s) => s.story === m.key).map((s) => ({ id: s.subtaskId, impl: { cli: s.implementer?.cli, model: s.implementer?.model }, ver: { cli: s.verifier?.cli, model: s.verifier?.model }, verify: s.verify, rounds: (s.rounds ?? []).map((r) => ({ round: r.round, verdict: r.verdict, diag: r.diagnostics ?? null })) })),
        prcheck: prc.filter((p) => p.stories.includes(m.key)),
      };
    });

  const sev = { blocking: 0, major: 0, minor: 0 };
  for (const p of prc) for (const u of p.upheld) sev[u.sev] = (sev[u.sev] ?? 0) + 1;
  const clk = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(Math.floor(((m % 60) + 60) % 60)).padStart(2, '0')}`;
  const startMin = r4(Math.min(...runs.map((r) => r.start)));
  const endMin = r4(Math.max(...runs.map((r) => r.end)));
  const genClock = clock(generatedAt);
  return {
    title, links, repoUrl, tz: tzLabel, rate, idleGapMin, generatedAt, generated: clk((genClock.day - baseDay) * 1440 + genClock.min),
    date: new Date(baseDay * 864e5).toISOString().slice(0, 10), first: clk(startMin), last: clk(endMin), startMin, endMin, bands,
    switchLabel: Object.entries(pairs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'CLI switch',
    total: fin(runs.reduce(addRun, acc())), opus: fin(runs.filter((r) => r.tier === 'opus').reduce(addRun, acc())), sonnet: fin(runs.filter((r) => r.tier !== 'opus').reduce(addRun, acc())),
    byCli: sumBy(runs, (r) => r.cli), byStage: sumBy(runs, (r) => r.stage), breakdown: breakdown(runs), premium: Math.round(runs.reduce((a, r) => a + r.premium, 0)),
    waste,
    prc: { rounds: prc.length, raised: prc.reduce((a, p) => a + p.raised, 0), upheld: prc.reduce((a, p) => a + p.upheld.length, 0), sev, serious: prc.flatMap((p) => p.upheld.filter((u) => ['blocking', 'major'].includes(u.sev)).map((u) => ({ t: p.target, ...u }))) },
    other: { ...fin(runs.filter((r) => !r.story).reduce(addRun, acc())), runs: runs.filter((r) => !r.story).map(tuple) },
    sources: [...new Set(runs.map((r) => r.src))].sort(),
    stories,
  };
}

export function renderHtml(kind, data) {
  const tpl = fs.readFileSync(TEMPLATES[kind], 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  if (!tpl.includes('/*__DATA__*/')) throw new Error(`${TEMPLATES[kind]} has no /*__DATA__*/ placeholder.`);
  return tpl.replace('/*__DATA__*/', () => json);
}

const svcOf = (text) => /\b([A-Z][A-Za-z]+\.(?:API|WebApp|Web|BackgroundTasks|Processor))\b/.exec(text ?? '')?.[1] ?? (/\b(WebApp|Blazor|UI)\b/.test(text ?? '') ? 'WebApp' : '');

// The pull request of each branch, from GitHub (best effort: none when gh is missing or offline).
function prsFor(config, branches) {
  const out = {};
  for (const b of branches) {
    if (!b || b.startsWith('(')) continue;
    const res = run('gh', ['pr', 'list', '--repo', config.tickets?.repo ?? '', '--head', b, '--state', 'all', '--json', 'number,url', '--limit', '1'], { cwd: config.root, timeoutSec: 30 });
    try {
      const [pr] = JSON.parse(res.stdout || '[]');
      if (pr) out[b] = pr;
    } catch {
      /* gh unavailable */
    }
  }
  return out;
}

const pagesUrl = (repo) => {
  const [owner, name] = String(repo).split('/');
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
};

// Pushes one page (index.html + data.json) to a GitHub Pages repo, creating it (public, Pages on main) the
// first time. Returns the public URL.
export function publishPage(config, repo, html, data, { message = 'Update dashboard' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-'));
  try {
    const exists = run('gh', ['repo', 'view', repo, '--json', 'name'], { cwd: config.root }).status === 0;
    if (exists) {
      const c = run('gh', ['repo', 'clone', repo, tmp, '--', '-q'], { cwd: config.root });
      if (c.status !== 0) throw new Error(`gh repo clone ${repo} failed: ${c.stderr}`);
    } else run('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'index.html'), html);
    fs.writeFileSync(path.join(tmp, 'data.json'), `${JSON.stringify(data, null, 1)}\n`);
    run('git', ['add', '-A'], { cwd: tmp });
    const commit = run('git', ['commit', '-q', '-m', message], { cwd: tmp });
    if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr)) throw new Error(`commit failed: ${commit.stderr}`);
    if (exists) {
      const push = run('git', ['push', '-q'], { cwd: tmp });
      if (push.status !== 0) throw new Error(`push to ${repo} failed: ${push.stderr}`);
    } else {
      const create = run('gh', ['repo', 'create', repo, '--public', '--source', tmp, '--push'], { cwd: tmp });
      if (create.status !== 0) throw new Error(`gh repo create ${repo} failed: ${create.stderr}`);
      run('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/'], { cwd: tmp });
    }
    return pagesUrl(repo);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Builds both dashboards for an epic (or for the given stories), writes them under the configured output
// folder, and publishes them when asked. Returns the files and URLs.
export function generateDashboards(config, { epic = null, stories = null, refs = null, out = null, publish = false, rate = null } = {}) {
  const dc = dashboardConfig(config);
  let meta;
  let slug;
  let title;
  let epicIssue = null;
  if (epic) {
    slug = epic.replace(/^epic-/, '');
    let tickets = [];
    try {
      // Fetches the epic and its tickets into the cache first, so listEpics below sees them.
      tickets = epicTickets(config, slug, { fetch: true });
    } catch (error) {
      log(`dashboard: could not list the epic's tickets (${error.message.split('\n')[0]}); using the metrics only`);
    }
    const e = listEpics(config).find((x) => x.key === slug || x.ticket === epic);
    slug = e?.key ?? slug;
    epicIssue = loadTicket(config, `epic-${slug}`, { fetch: false })?.issue ?? null;
    title = `${epicIssue ? `Epic #${epicIssue.number} · ` : ''}${e?.title ?? slug}`;
    meta = tickets.map((t) => ({ key: t.key, title: t.title, issue: t.issue?.number ?? null, blockedBy: t.blockedBy, svc: svcOf(ticketText(config, t)) }));
    if (!meta.length && e) meta = [...e.stories].map((key) => ({ key, title: key }));
  } else {
    meta = (stories ?? []).map((key) => {
      const t = loadTicket(config, key, { fetch: true });
      return { key, title: t?.title ?? key, issue: t?.issue?.number ?? null, blockedBy: t?.blockedBy ?? [], svc: svcOf(t && ticketText(config, t)) };
    });
    slug = meta.length === 1 ? meta[0].key.toLowerCase() : 'stories';
    title = meta.length ? meta.map((m) => m.key).join(', ') : 'All agent runs';
  }
  const refList = refs ?? (epic ? epicRefs(config, slug) : []);
  const { files } = loadSources(config, refList);
  const scope = epic || stories?.length ? { epic: epic ? slug : null, escalations: listEscalations(config) } : null;
  const prs = prsFor(config, [...new Set(files['token-usage'].map((r) => r._src))]);
  for (const m of meta) m.prs = prs;
  const pages = dc.pages[slug] ?? dc.pages['*'] ?? null;
  const pageRepo = (kind) => (pages?.[kind] ? pages[kind].replace('{slug}', slug) : null);
  const repoUrl = config.tickets?.repo ? `https://github.com/${config.tickets.repo}` : null;
  const links = [
    ...(epicIssue?.url ? [{ label: `epic #${epicIssue.number}`, url: epicIssue.url }] : []),
    ...(dc.runLog?.[slug] ? [{ label: dc.runLog[slug].label, url: dc.runLog[slug].url }] : []),
  ];
  const data = buildDashboard(files, { meta, scope, title, links, repoUrl, timeZone: dc.timeZone, tzLabel: dc.tzLabel, idleGapMin: dc.idleGapMin, rate: rate ?? dc.rate });
  const outDir = path.resolve(config.root, out ?? dc.out, slug);
  const result = { dir: outDir, files: {}, urls: {} };
  for (const kind of ['epic', 'story']) {
    const other = kind === 'epic' ? 'story' : 'epic';
    const otherUrl = pageRepo(other) ? pagesUrl(pageRepo(other)) : `../${other}/index.html`;
    const d = { ...data, kind, links: [...data.links, { label: `${other}-level dashboard ↗`, url: otherUrl }] };
    const html = renderHtml(kind, d);
    const file = path.join(outDir, kind, 'index.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    fs.writeFileSync(path.join(outDir, kind, 'data.json'), `${JSON.stringify(d, null, 1)}\n`);
    result.files[kind] = file;
    if (publish) {
      if (!pageRepo(kind)) throw new Error(`No GitHub Pages repo for the ${kind} dashboard of ${slug}: set dashboard.pages["${slug}"].${kind} (or dashboard.pages["*"]) in scripts/pipeline/config.json.`);
      result.urls[kind] = publishPage(config, pageRepo(kind), html, d, { message: `Dashboard: ${title} (${d.total.runs} runs, $${d.total.cost.toFixed(2)}, to ${d.last} ${d.tz})` });
    }
  }
  result.data = data;
  return result;
}
