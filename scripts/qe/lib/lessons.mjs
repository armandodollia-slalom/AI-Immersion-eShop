import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../../pipeline/lib/agents.mjs';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { git, revExists } from '../../pipeline/lib/git.mjs';
import { AGENT_STAGE, categoryStats, loadMetrics } from './metrics.mjs';
import { automationStatus, planStatus } from './plans.mjs';
import { automationVerifierTaskFor, planVerifierTaskFor } from './workflows.mjs';
import { stateDir } from '../../pipeline/lib/state.mjs';
import { listStories } from '../../pipeline/lib/stories.mjs';
import { appendJsonl, extractResult, log, nowIso, readJson, run, writeJson } from '../../pipeline/lib/util.mjs';
import { digestIsEmpty, retroDigest, retroSince } from './retro.mjs';
import { VERIFIER, metricsFile, runVerifier } from './verify.mjs';
import { LENSES } from '../../pr-check/lib/loop.mjs';

const RULE = /^##\s+(L\d+)[:.]?\s*(.*)$/;
const MARKER = /<!--\s*category:\s*([^;>]+?)\s*(?:;\s*subtype:\s*([^;>]*?)\s*)?;\s*added:\s*([0-9T:.\-Z]+)\s*(?:;[^>]*)?-->/;

export function parseRules(text) {
  const rules = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heading = RULE.exec(lines[i]);
    if (!heading) continue;
    const marker = lines.slice(i + 1, i + 4).map((l) => MARKER.exec(l)).find(Boolean);
    rules.push({
      id: heading[1],
      title: heading[2],
      category: marker?.[1]?.trim() ?? null,
      subtype: marker?.[2]?.trim() || null,
      added: marker?.[3] ?? null,
    });
  }
  return rules;
}

const lessonsPath = (config, agent, root = config.root) => path.join(root, config.lessonsDir, `${agent}.md`);

// The implementer learns from architecture review denials (.agent-metrics/arch-reviews.jsonl): every
// blocking finding, from the Architecture Policy Pack (subtype = rule id) or the LLM reviewer.
export const IMPLEMENTER = 'implementer';

function reviewDenials(reviews = []) {
  return reviews
    .filter((r) => r.verdict === 'CHANGES_REQUESTED')
    .flatMap((r) =>
      (r.findings ?? [])
        .filter((f) => (f.severity ?? 'blocking') === 'blocking')
        .map((f) => ({
          ts: r.ts,
          story: r.story,
          attributed_agent: IMPLEMENTER,
          category: f.category ?? 'other',
          subtype: f.rule ?? null,
          case: `review round ${r.round} (${r.reviewer ?? 'architecture-reviewer'})`,
          detail: f.issue ?? null,
          location: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : null,
        })),
    );
}

// Implementation bugs the integration tests found (decision log, stage automation): the implementer
// shipped code that contradicts a verified test case. Category product-bug; no subtype.
function productBugs(decisions = []) {
  return decisions
    .filter((d) => d.stage === 'automation' && d.decision === 'product-bug')
    .flatMap((d) =>
      (d.items ?? []).map((b) => ({
        ts: d.ts,
        story: d.story,
        attributed_agent: IMPLEMENTER,
        category: 'product-bug',
        subtype: null,
        case: b.case ?? `automation round ${d.round}`,
        detail: [b.expected && `expected ${b.expected}`, b.actual && `got ${b.actual}`, b.reason].filter(Boolean).join('; ') || null,
        location: b.location ?? null,
      })),
    );
}

// The PR check (.agent-metrics/pr-checks.jsonl) teaches three kinds of agent:
// - implementer: findings upheld in round 1, i.e. against the code as the implementer wrote it;
// - pr-check-fixer: findings upheld again after the fixer had a round to fix them;
// - each critic (pr-check-<lens>): its findings the judge dismissed (false positives).
export const PR_CHECK_FIXER = 'pr-check-fixer';
export const PR_CHECK_CRITICS = Object.fromEntries(Object.entries(LENSES).map(([lens, l]) => [l.agent, lens]));
const PR_CHECK_AGENTS = [PR_CHECK_FIXER, ...Object.keys(PR_CHECK_CRITICS)];

function prCheckEntries(checks = [], agent) {
  const entry = (r, f, extra) => ({
    ts: r.ts,
    story: r.story,
    attributed_agent: agent,
    case: `PR check ${r.target} round ${r.round} (${f.id})`,
    detail: [f.title, f.detail ?? f.reason].filter(Boolean).join(': ') || null,
    location: f.evidence || null,
    ...extra,
  });
  return checks.flatMap((r) => {
    if (agent === IMPLEMENTER) {
      return r.round === 1 ? (r.upheld ?? []).filter((f) => f.title).map((f) => entry(r, f, { category: `pr-check-${f.lens}`, subtype: null })) : [];
    }
    if (agent === PR_CHECK_FIXER) {
      return (r.upheld ?? []).filter((f) => f.repeat).map((f) => entry(r, f, { category: 'not-fixed', subtype: f.lens }));
    }
    const lens = PR_CHECK_CRITICS[agent];
    return (r.dismissed ?? []).filter((f) => f.lens === lens).map((f) => entry(r, f, { category: 'dismissed-finding', subtype: null, location: null }));
  });
}

function entriesFor(data, agent) {
  if (agent === IMPLEMENTER) return [...reviewDenials(data.reviews), ...prCheckEntries(data.prChecks, agent), ...productBugs(data.decisions)];
  if (PR_CHECK_AGENTS.includes(agent)) return prCheckEntries(data.prChecks, agent);
  if (agent.endsWith('-verifier')) return data.calibration.filter((d) => d.attributed_agent === agent);
  return data.denials.filter((d) => d.attributed_agent === agent);
}

function runsFor(data, agent) {
  const checks = data.prChecks ?? [];
  if (agent === IMPLEMENTER) return [...(data.reviews ?? []), ...checks.filter((r) => r.round === 1)];
  if (agent === PR_CHECK_FIXER) return checks.filter((r) => r.round > 1);
  const lens = PR_CHECK_CRITICS[agent];
  if (lens) return checks.filter((r) => r.lensScores && lens in r.lensScores);
  const stage = AGENT_STAGE[agent];
  return data.runs.filter((r) => r.stage === stage);
}

// Decides, from the denial log alone, what each agent's lessons file should gain or lose.
export function lessonCandidates(config, data, agent, lessonsText) {
  const settings = config.lessons;
  const entries = entriesFor(data, agent);
  const runs = runsFor(data, agent);
  const rules = parseRules(lessonsText);
  const matches = (rule, d) => d.category === rule.category && (!rule.subtype || rule.subtype === d.subtype);

  const ruleReport = rules.map((rule) => {
    if (!rule.added || !rule.category) return { ...rule, action: 'keep', note: 'no tracking marker' };
    const after = runs.filter((r) => r.ts > rule.added);
    const before = runs.filter((r) => r.ts <= rule.added);
    const hitsAfter = entries.filter((d) => d.ts > rule.added && matches(rule, d));
    const hitsBefore = entries.filter((d) => d.ts <= rule.added && matches(rule, d));
    const storiesAfter = new Set(after.map((r) => r.story)).size;
    const rateAfter = after.length ? hitsAfter.length / after.length : 0;
    const rateBefore = before.length ? hitsBefore.length / before.length : 0;
    let action = 'keep';
    if (storiesAfter >= settings.retireAfterStories && hitsAfter.length === 0) action = 'retire';
    else if (after.length >= settings.revertMinRounds && rateBefore > 0 && rateAfter >= rateBefore) action = 'revert';
    return { ...rule, action, storiesAfter, hitsAfter: hitsAfter.length, rateBefore: +rateBefore.toFixed(3), rateAfter: +rateAfter.toFixed(3) };
  });

  const recurring = categoryStats(entries).filter((c) => c.stories >= settings.storyThreshold);
  const newOrStrengthen = recurring
    .map((c) => {
      const rule = rules.find((r) => r.category === c.category && (!r.subtype || r.subtype === c.subtype));
      const relevant = entries.filter((d) => d.category === c.category && (d.subtype ?? null) === c.subtype && (!rule?.added || d.ts > rule.added));
      const stories = new Set(relevant.map((d) => d.story)).size;
      if (stories < settings.storyThreshold) return null;
      const examples = relevant
        .slice(-settings.examplesPerCategory)
        .map((d) => ({ story: d.story, case: d.case, detail: d.detail, location: d.location }));
      return { action: rule ? 'strengthen' : 'add', rule: rule?.id ?? null, category: c.category, subtype: c.subtype, count: relevant.length, stories, examples };
    })
    .filter(Boolean);

  const actionable = [...newOrStrengthen, ...ruleReport.filter((r) => r.action !== 'keep')];
  return { agent, rules: ruleReport, changes: newOrStrengthen, actionable: actionable.length > 0 };
}

export const LESSON_AGENTS = ['qe-plan', 'qe-automation', VERIFIER.plan, VERIFIER.automation, IMPLEMENTER, ...PR_CHECK_AGENTS];

function lessonsTask(config, reports, root, digest = null) {
  const lines = [
    `Maximum rules per file: ${config.lessons.maxRules}. Today: ${nowIso()}.`,
    reports.length
      ? 'Edit the lessons files listed below as requested. Every rule you add or rewrite must carry the tracking marker on the line after its heading, with added set to today.'
      : 'No lessons file needs a change this time.',
    '',
  ];
  for (const report of reports) {
    const file = path.relative(root, lessonsPath(config, report.agent, root));
    lines.push(`## ${report.agent} (${file})`, '', 'Current file:', '', '````markdown', fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8').trimEnd() : '(missing)', '````', '');
    lines.push('Requested changes (JSON):', '', '```json', JSON.stringify({ changes: report.changes, rules: report.rules.filter((r) => r.action !== 'keep') }, null, 2), '```', '');
  }
  if (digest) {
    lines.push(
      '## Factory retro',
      '',
      `The decision log since ${digest.since}: why each agent decided what it did. Look for root causes that a lessons rule cannot fix (an unclear agent definition, a gap in the docs or the story template, a policy rule that keeps misfiring, a verifier that is too strict or too lax) and fix them by editing files under: ${allowedPaths(config).join(', ')}.`,
      'Only propose changes the evidence supports across stories; list every file you change in `proposals` with the evidence. Leave everything else alone.',
      '',
      '```json',
      JSON.stringify(digest, null, 2),
      '```',
      '',
    );
  }
  return lines.join('\n');
}

const allowedPaths = (config) => config.lessons.retro?.allowedPaths ?? [];
const inside = (file, dirs) => dirs.some((d) => file === d.replace(/\/$/, '') || file.startsWith(d.endsWith('/') ? d : `${d}/`));

// Files changed in a checkout, including untracked files.
const changedFiles = (root) =>
  git(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean).map((l) => ({ file: l.slice(3).replace(/^.* -> /, ''), untracked: l.startsWith('??') }));

function proposalsFrom(output) {
  const proposals = extractResult(output)?.proposals;
  return (Array.isArray(proposals) ? proposals : []).filter((p) => p?.file).map((p) => ({ file: String(p.file), why: String(p.why ?? '') }));
}

export async function lessonsCommand(config, { dryRun = false, local = false, ifDue = false, push = true } = {}) {
  const lastFile = path.join(stateDir(config), 'lessons-last.json');
  const last = readJson(lastFile, {});
  if (ifDue && last.ts && Date.now() - Date.parse(last.ts) < config.lessons.intervalDays * 86_400_000) {
    log(`lessons: last run ${last.ts}; not due yet.`);
    return { status: 'not-due' };
  }
  const data = loadMetrics(config);
  const reports = LESSON_AGENTS.map((agent) => {
    const file = lessonsPath(config, agent);
    return lessonCandidates(config, data, agent, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  });
  const actionable = reports.filter((r) => r.actionable);
  const retro = config.lessons.retro?.enabled === false ? null : retroDigest(config, data.decisions ?? [], retroSince(config));
  const digest = retro && !digestIsEmpty(retro) ? retro : null;
  writeJson(lastFile, { ts: nowIso(), actionable: actionable.map((r) => r.agent), retro: digest ? digest.counts : null });
  if (dryRun || (actionable.length === 0 && !digest)) {
    log(dryRun ? 'lessons: dry run' : 'lessons: no recurring denials past the threshold, no rules to retire or revert and no new decisions to review.');
    return { status: dryRun ? 'dry-run' : 'nothing-to-do', reports, digest };
  }

  let root = config.root;
  let branch = null;
  if (!local) {
    branch = `qe/lessons-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    root = path.join(stateDir(config), 'worktrees', branch.replace('/', '-'));
    const base = revExists(config.root, config.baseRef) ? config.baseRef : 'HEAD';
    const added = git(config.root, ['worktree', 'add', '-b', branch, root, base]);
    if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
  }
  try {
    const result = runAgent(config, { name: 'qe-lessons', mode: 'write', cwd: root, timeoutSec: config.timeoutsSec.lessons, task: lessonsTask(config, actionable, root, digest) });
    if (!result.ok) throw new Error('lessons agent failed');
    const writable = [config.lessonsDir, ...(digest ? allowedPaths(config) : [])];
    const outside = changedFiles(root).filter((c) => !inside(c.file, writable));
    if (outside.length) {
      log(`lessons: discarding edits outside ${writable.join(', ')}: ${outside.map((c) => c.file).join(', ')}`);
      if (!local) {
        const tracked = outside.filter((c) => !c.untracked).map((c) => c.file);
        if (tracked.length) git(root, ['checkout', '--', ...tracked]);
        for (const c of outside.filter((x) => x.untracked)) fs.rmSync(path.join(root, c.file), { force: true });
      }
    }
    // Agent definitions have generated copies for Claude Code; keep them in sync with any retro edit.
    if (changedFiles(root).some((c) => /^\.github\/agents\/[^/]+\.agent\.md$/.test(c.file))) {
      const sync = path.join(root, 'scripts/sync-agents.mjs');
      run(process.execPath, [fs.existsSync(sync) ? sync : path.join(INSTALL_ROOT, 'scripts/sync-agents.mjs')], { cwd: root });
    }
    const proposals = digest ? proposalsFrom(result.output) : [];
    for (const agent of LESSON_AGENTS) {
      const file = lessonsPath(config, agent, root);
      if (!fs.existsSync(file)) continue;
      const count = parseRules(fs.readFileSync(file, 'utf8')).length;
      if (count > config.lessons.maxRules) throw new Error(`${agent} lessons file has ${count} rules (max ${config.lessons.maxRules}).`);
    }
    if (local) return { status: 'applied-locally', reports: actionable, proposals };
    const toCommit = changedFiles(root).map((c) => c.file);
    if (!toCommit.length) return { status: 'no-edits', reports: actionable, proposals };
    git(root, ['add', '--', ...toCommit]);
    // Carry calibration audits run in this checkout (e.g. by CI) into the PR so they are not lost.
    const calibration = path.join(config.metricsDir, 'calibration.jsonl');
    if (fs.existsSync(path.join(config.root, calibration))) {
      fs.mkdirSync(path.join(root, config.metricsDir), { recursive: true });
      fs.copyFileSync(path.join(config.root, calibration), path.join(root, calibration));
      git(root, ['add', '--', calibration]);
    }
    const summary =
      actionable
        .map((r) => `- **${r.agent}**: ${[...r.changes.map((c) => `${c.action} ${c.category}${c.subtype ? `/${c.subtype}` : ''} (${c.stories} stories)`), ...r.rules.filter((x) => x.action !== 'keep').map((x) => `${x.action} ${x.id} ${x.category}`)].join('; ')}`)
        .join('\n') || '- No lessons file changes.';
    const factory = proposals.length
      ? `\n\n### Proposed factory changes (needs human review)\n\nFrom the decision log since ${digest.since}:\n\n${proposals.map((p) => `- \`${p.file}\`: ${p.why}`).join('\n')}`
      : '';
    const message = `Update agent lessons from verifier, architecture review and PR check findings\n\n${summary}${factory}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;
    git(root, ['commit', '-m', message], { allowFail: false });
    if (!push) return { status: 'committed', branch, worktree: root };
    git(root, ['push', '-u', 'origin', branch], { allowFail: false });
    const body = `Generated by \`node scripts/qe/qe.mjs lessons\` from \`.agent-metrics/\`.\n\n${summary}${factory}\n\nReview each rule: it should be concrete, generalize beyond the examples, and not contradict the agent definition.`;
    const pr = run('gh', ['pr', 'create', '--head', branch, '--title', 'Update agent lessons from verifier, architecture review and PR check findings', '--body', body], { cwd: root });
    log(pr.status === 0 ? `lessons: opened ${pr.stdout.trim()}` : `lessons: push done, PR creation failed: ${pr.stderr}`);
    return { status: 'pr', branch, url: pr.stdout.trim(), proposals };
  } finally {
    if (!local) git(config.root, ['worktree', 'remove', '--force', root]);
  }
}

// Re-checks recent 10/10 results with a stricter auditor so the verifiers themselves can improve.
export function calibrateCommand(config, { stage = null, sample = 3 } = {}) {
  const data = loadMetrics(config);
  const stories = listStories(config);
  const stages = stage ? [stage] : ['plan', 'automation'];
  const results = [];
  for (const s of stages) {
    const latest = new Map();
    for (const r of data.runs.filter((x) => x.stage === s && x.passed)) latest.set(r.story, r);
    const candidates = [...latest.values()]
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .map((r) => ({ run: r, story: stories.find((x) => x.key === r.story) }))
      .filter(({ story }) => story && (s === 'plan' ? planStatus(config, story).state === 'verified' : automationStatus(config, story).state === 'verified'))
      .slice(0, sample);
    for (const { run: original, story } of candidates) {
      const task = `${s === 'plan' ? planVerifierTaskFor(config, story) : automationVerifierTaskFor(config, story)}\n\nAUDIT MODE: another verifier already scored this ${original.score}/10. Re-check it independently and strictly; report every gap you find.`;
      const verdict = runVerifier(config, { stage: s, story, round: 0, producerVersion: original.agent_prompt_ver, task, model: config.agent.models.audit, metrics: false });
      if (verdict.error) continue;
      const misses = verdict.gaps.map((g) => ({ ts: nowIso(), stage: s, story: story.key, verifier_ver: original.verifier_ver, audit_score: verdict.score, ...g, attributed_agent: VERIFIER[s] }));
      appendJsonl(metricsFile(config, 'calibration.jsonl'), misses.length ? misses : [{ ts: nowIso(), stage: s, story: story.key, verifier_ver: original.verifier_ver, audit_score: verdict.score, category: 'agreed', attributed_agent: 'none' }]);
      results.push({ stage: s, story: story.key, auditScore: verdict.score, misses: misses.length });
    }
  }
  return results;
}
