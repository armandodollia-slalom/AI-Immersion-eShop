// Assessment of a published fix PR: the triage agent's ratings per ticket, plus everything the harness
// computes from the diff and the pipeline's records (systems, severity, confidence), recorded on the
// tickets (issue body `## Triage`, board fields) and in the decision log (`bug-triage`).
import fs from 'node:fs';
import path from 'node:path';
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { nowIso, readJsonl } from '../../pipeline/lib/util.mjs';
import { readMeta, ticketFile } from '../../board/lib/source.mjs';
import { runTriage } from './assess.mjs';
import { confidence, ticketSignals } from './confidence.mjs';
import { setTriageFields } from './fields.mjs';
import { checksState, issueBody, prNumber, setIssueBody } from './github.mjs';
import { floorReasons, prClass, prSeverity, ticketSeverity } from './severity.mjs';
import { overridePathsHit, systemsTouched } from './systems.mjs';
import { extractTriage, upsertTriage } from './triage-section.mjs';

export const TRIAGE_STAGE = 'bug-triage';

// The main checkout of a worktree (the git common dir's parent): where board sync and the group
// outcomes write their metrics, since a published PR's branch must not get new commits for them.
export function mainCheckout(cwd) {
  const r = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.status === 0 ? r.stdout.trim() : '';
  return common && path.basename(common) === '.git' ? path.dirname(common) : cwd;
}

const lines = (s) => String(s ?? '').split('\n').filter(Boolean);

export function prFilesLocal(cwd, base) {
  return lines(git(cwd, ['diff', '--name-only', `${base}...HEAD`]).stdout);
}

export function prDiffLocal(cwd, base, maxChars) {
  let diff = git(cwd, ['diff', '--no-ext-diff', `${base}...HEAD`, '--', '.', ':(exclude)graphify-out', ':(exclude).agent-metrics']).stdout;
  if (diff.length > maxChars) diff = `${diff.slice(0, maxChars)}\n... diff truncated at ${maxChars} chars; read the remaining files directly.`;
  return diff;
}

// Files per ticket: in a group branch each ticket arrived as `<KEY>: Merge into <branch>`, so its files
// are that merge's diff against its first parent. A ticket without such a merge (a single-ticket PR)
// gets every file of the PR.
export function ticketFilesLocal(cwd, base, keys, all) {
  if (keys.length < 2) return Object.fromEntries(keys.map((k) => [k, all]));
  const log = lines(git(cwd, ['log', '--first-parent', '--format=%H%x09%s', `${base}..HEAD`]).stdout).map((l) => l.split('\t'));
  return Object.fromEntries(
    keys.map((k) => {
      const merge = log.find(([, subject]) => subject?.startsWith(`${k}: Merge into `));
      const files = merge ? lines(git(cwd, ['diff', '--name-only', `${merge[0]}^1`, merge[0]]).stdout) : [];
      return [k, files.length ? files : all];
    }),
  );
}

export function loadTicket(config, key) {
  const meta = readMeta(config, key) ?? {};
  const file = ticketFile(config, key);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { key, title: meta.title ?? /^#\s+(.+)$/m.exec(text)?.[1] ?? key, text, issue: meta.issue?.number ? { number: meta.issue.number, url: meta.issue.url } : null, type: meta.type ?? null };
}

export function readMetrics(config) {
  const read = (f) => readJsonl(path.join(config.root, config.metricsDir, f));
  return { implementRuns: read('implement-runs.jsonl'), subtaskRuns: read('subtask-runs.jsonl'), prChecks: read('pr-checks.jsonl'), outcomes: read('decision-outcomes.jsonl') };
}

// One ticket's assessment from its rating, files, signals and earlier triage (its reopens).
export function assessTicket({ ticket, rating, files, systemsSettings, signals, prior, settings }) {
  const reopens = prior?.reopens ?? [];
  const floor = rating ? floorReasons({ files, categories: rating.categories }, settings, { overridePathsHit }) : [];
  const severity = rating ? ticketSeverity({ impact: rating.impact, complexity: rating.complexity, fixRisk: rating.fixRisk, floorReasons: floor, reopens: reopens.length }, settings) : ticketSeverity({}, settings);
  const conf = confidence({ ...signals, agent: rating?.agentConfidence ?? null }, settings.confidence);
  return {
    key: ticket.key,
    title: ticket.title,
    issue: ticket.issue,
    impact: rating?.impact ?? null,
    impactReason: rating?.impactReason ?? null,
    complexity: rating?.complexity ?? null,
    complexityReason: rating?.complexityReason ?? null,
    fixRisk: rating?.fixRisk ?? null,
    fixRiskReason: rating?.fixRiskReason ?? null,
    categories: rating?.categories ?? [],
    summary: rating?.summary ?? null,
    agentConfidence: rating?.agentConfidence ?? null,
    floorReasons: floor,
    severity,
    confidence: conf,
    signals,
    systems: systemsTouched(files, systemsSettings).names,
    files: files.length,
    paths: files.slice(0, 200),
    reopens,
  };
}

// Assesses a published PR from its worktree. deps: { gh, runAgent, log }.
export function assessPr(config, { pr, keys, cwd = config.root, base }, deps) {
  const s = config.implement.reviewGate;
  const repo = config.board.repo;
  const log = deps.log ?? (() => {});
  const files = prFilesLocal(cwd, base);
  const systems = systemsTouched(files, s);
  const tickets = keys.map((k) => loadTicket(config, k));
  const perTicket = ticketFilesLocal(cwd, base, keys, files);
  const triage = runTriage(config, { pr, tickets, systems, files, diff: prDiffLocal(cwd, base, s.maxDiffChars ?? 120_000), cwd }, deps);
  const ci = pr ? safe(() => checksState(deps.gh, repo, pr), null) : null;
  const metrics = readMetrics(config);
  const assessed = tickets.map((t) => {
    const prior = t.issue ? safe(() => extractTriage(issueBody(deps.gh, repo, t.issue.number)), null) : null;
    const signals = ticketSignals(t.key, metrics, { ci });
    return assessTicket({ ticket: t, rating: triage.ratings.get(t.key) ?? null, files: perTicket[t.key] ?? files, systemsSettings: s, signals, prior, settings: s });
  });
  const severity = prSeverity({ tickets: assessed, systems }, s);
  if (triage.errors.length) log(`triage: ${triage.errors.join('; ')}`);
  return {
    pr,
    number: prNumber(pr),
    repo,
    base,
    headSha: git(cwd, ['rev-parse', 'HEAD']).stdout.trim() || null,
    assessedAt: nowIso(),
    files: files.length,
    systems,
    tickets: assessed,
    severity,
    class: prClass({ severity: severity.level, shared: systems.shared || systems.contract }),
    ci,
    errors: triage.errors,
  };
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// The data stored in a ticket's `## Triage` section.
export const triageData = (a, t) => ({
  v: 1,
  key: t.key,
  pr: a.pr,
  assessedAt: a.assessedAt,
  impact: t.impact,
  impactReason: t.impactReason,
  complexity: t.complexity,
  complexityReason: t.complexityReason,
  fixRisk: t.fixRisk,
  fixRiskReason: t.fixRiskReason,
  categories: t.categories,
  floorReasons: t.floorReasons,
  severity: t.severity,
  confidence: { score: t.confidence.score, high: t.confidence.high, criteria: t.confidence.criteria, reasons: t.confidence.reasons },
  agentConfidence: t.agentConfidence,
  systems: t.systems,
  paths: (t.paths ?? []).slice(0, 50),
  summary: t.summary,
  reopens: t.reopens,
});

export const fieldValues = (t) => ({ impact: t.impact, complexity: t.complexity, fixRisk: t.fixRisk, severity: t.severity?.level ?? null, confidence: t.confidence?.score ?? null, reopens: t.reopens?.length ?? 0 });

// Writes one ticket's triage to its issue (body section and board fields). Never throws; returns
// the problems.
export function recordTicket(config, gh, assessment, t) {
  const problems = [];
  if (!t.issue) return ['no issue'];
  const repo = config.board.repo;
  try {
    const body = issueBody(gh, repo, t.issue.number);
    const next = upsertTriage(body, triageData(assessment, t));
    if (next !== body.replace(/\r\n/g, '\n')) setIssueBody(gh, repo, t.issue.number, next);
  } catch (error) {
    problems.push(`issue body: ${error.message.split('\n')[0]}`);
  }
  try {
    if (config.board?.projectNumber) setTriageFields(config, gh, t.issue, fieldValues(t));
  } catch (error) {
    problems.push(`board fields: ${error.message.split('\n')[0]}`);
  }
  return problems;
}

// The `bug-triage` decision of one PR, in the decision log of `metricsConfig` (the main checkout).
export function logTriageDecision(metricsConfig, a, gate = null) {
  return logDecision(metricsConfig, {
    stage: TRIAGE_STAGE,
    story: a.tickets[0]?.key ?? null,
    agent: 'bug-triage',
    subject: 'implementer',
    decision: gate?.action ?? 'assessed',
    reason: [`PR severity ${a.severity.level ?? 'unknown'} (${a.severity.explanation})`, gate?.reasons?.length ? `review: ${gate.reasons.join('; ')}` : null].filter(Boolean).join('. '),
    pr: a.pr,
    stories: a.tickets.map((t) => t.key),
    pr_severity: a.severity.level,
    pr_class: a.class,
    systems: a.systems.names,
    shared: a.systems.shared,
    contract: a.systems.contract,
    approvals: gate?.approvals ?? null,
    ci: a.ci,
    errors: a.errors,
    items: a.tickets.map((t) => ({
      story: t.key,
      impact: t.impact,
      complexity: t.complexity,
      fix_risk: t.fixRisk,
      severity: t.severity?.level ?? null,
      severity_base: t.severity?.base ?? null,
      severity_bump: t.severity?.bump ?? 0,
      floor: t.floorReasons,
      confidence: t.confidence?.score ?? null,
      high_confidence: Boolean(t.confidence?.high),
      agent_confidence: t.agentConfidence,
      reopens: t.reopens?.length ?? 0,
      systems: t.systems,
      reason: t.severity?.explanation ?? null,
    })),
  });
}
