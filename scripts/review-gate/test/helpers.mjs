// Shared fixtures for the review gate tests: the real gate settings, a temp git repo with a fix branch,
// cached tickets, metrics records and a fake triage agent.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const implementConfig = JSON.parse(fs.readFileSync(path.join(here, '../../implement/config.json'), 'utf8'));
export const SETTINGS = implementConfig.implement.reviewGate;
export const AUTO_MERGE = implementConfig.implement.autoMerge;

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
export const jsonl = (root, rel, records) => write(root, rel, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

export function gateConfigFor(root, extra = {}) {
  return {
    root,
    stateDir: '.agent-state',
    metricsDir: '.agent-metrics',
    tickets: { dir: '.agent-state/board' },
    agent: { models: { bugTriage: 'opus' } },
    implement: { reviewGate: structuredClone(SETTINGS), autoMerge: { ...AUTO_MERGE, ...(extra.autoMerge ?? {}) } },
    board: { repo: 'acme/shop', owner: 'acme', ownerType: 'user', projectNumber: 1, fields: {}, columns: { inProgress: 'In Progress', review: 'Pending Review', done: 'Done' }, epicLabel: 'epic' },
  };
}

// A repo on `main` with a fix branch checked out. `merges`: [{ key, files: { path: text } }] are merged
// into the fix branch one at a time as `<KEY>: Merge into <branch>` (a group PR); `files` without
// merges are committed directly (a single-ticket PR).
export function fixRepo({ files = {}, merges = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  write(root, 'README.md', '# shop\n');
  write(root, '.gitignore', '.agent-state/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  git(root, 'checkout', '-qb', 'bugfix/epic/g1');
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  if (Object.keys(files).length) {
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'fix');
  }
  for (const m of merges) {
    git(root, 'checkout', '-qb', `feat/${m.key.toLowerCase()}`, 'bugfix/epic/g1');
    for (const [rel, text] of Object.entries(m.files)) write(root, rel, text);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', `${m.key}: Implementation`);
    git(root, 'checkout', '-q', 'bugfix/epic/g1');
    git(root, 'merge', '--no-ff', '-q', '-m', `${m.key}: Merge into bugfix/epic/g1`, `feat/${m.key.toLowerCase()}`);
  }
  return root;
}

export function cacheTicket(root, key, { number, type = 'bug', text = null } = {}) {
  write(root, `.agent-state/board/${key}/story.md`, text ?? `# ${key}: Something is broken\n\nSteps to reproduce.\n`);
  write(root, `.agent-state/board/${key}/meta.json`, JSON.stringify({ key, type, title: `${key}: Something is broken`, issue: number ? { number, url: `https://github.com/acme/shop/issues/${number}` } : null }));
}

// The pipeline records of a ticket that went smoothly: no QE bug fix, one pair round, PR check 10/10
// in round 1, nothing outside owns.
export function cleanMetrics(root, keys, overrides = {}) {
  const runs = [];
  const outcomes = [];
  const checks = [];
  for (const key of keys) {
    const o = overrides[key] ?? {};
    outcomes.push({ ts: '2026-11-01T09:00:00Z', type: 'story', story: key, decisionId: `d-${key}`, bugFixCycles: o.bugFixCycles ?? 0 });
    runs.push({ ts: '2026-11-01T08:00:00Z', story: key, decisionId: `d-${key}`, subtaskId: 'fix', approved: o.approved ?? true, rounds: Array.from({ length: o.rounds ?? 1 }, (_, i) => ({ round: i + 1, outOfOwnsEdits: o.outOfOwns && i === 0 ? 1 : 0 })), filesNeededOutsideOwns: [] });
    for (const score of o.prChecks ?? [10]) checks.push({ ts: `2026-11-01T09:3${checks.length}:00Z`, story: key, round: 1, score });
  }
  jsonl(root, '.agent-metrics/decision-outcomes.jsonl', outcomes);
  jsonl(root, '.agent-metrics/subtask-runs.jsonl', runs);
  jsonl(root, '.agent-metrics/pr-checks.jsonl', checks);
}

// A fake triage agent: `ratings` per key, or a function (attempt, opts) -> AGENT_RESULT object.
export function fakeTriage(ratings) {
  const calls = [];
  const runAgent = (config, opts) => {
    calls.push(opts);
    const out = typeof ratings === 'function' ? ratings(calls.length, opts) : { tickets: Object.entries(ratings).map(([key, r]) => ({ key, impactReason: 'users see it', complexityReason: 'one file', fixRiskReason: 'isolated', categories: [], confidence: 90, summary: 'fixes it', ...r })) };
    return { ok: true, status: 0, output: `done\nAGENT_RESULT: ${JSON.stringify(out)}` };
  };
  return { runAgent, calls };
}

export const low = { impact: 'Low', complexity: 'Low', fixRisk: 'Low' };
