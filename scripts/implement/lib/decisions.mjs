// Decision log of the orchestrated implement flow: what the orchestrator decided (plan attempts), how
// each subtask went, and what happened afterwards (escaped defects, the story's outcome, late outcomes
// such as human commits before merge). Three append-only files under .agent-metrics/, joined by
// `decisionId` (one per accepted plan) and `subtaskId`. Builders, attribution and labeling are pure.
import { matchesAny } from './plan.mjs';

export const DECISIONS_FILE = 'orchestrator-decisions.jsonl';
export const SUBTASK_RUNS_FILE = 'subtask-runs.jsonl';
export const OUTCOMES_FILE = 'decision-outcomes.jsonl';

export const LABELS = ['over-provisioned', 'under-provisioned', 'bad-split', 'should-have-been-self', 'weak-verification'];

// Acceptance criteria counted from the story's "Acceptance Criteria" section: list items, table rows
// or Given/When/Then scenarios.
export function acceptanceCount(storyText) {
  const m = /^#{2,4}\s*Acceptance Criteria\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(storyText ?? '');
  if (!m) return null;
  const lines = m[1].split('\n');
  const items = lines.filter((l) => /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/.test(l)).length;
  const rows = lines.filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)).length;
  return items || Math.max(0, rows - 1) || lines.filter((l) => /^\s*(?:\*\*)?Given\b/i.test(l)).length;
}

const servicesFromOwns = (subtasks) => [...new Set(subtasks.flatMap((s) => s.owns ?? []).map((g) => /^(?:src|tests)\/([^/*?]+)/.exec(g)?.[1]).filter(Boolean))].sort();

export function storyFeatures(storyText, plan, { uiStory }) {
  const declared = plan?.decision?.features ?? {};
  return {
    services: declared.services ?? (plan ? servicesFromOwns(plan.subtasks.filter((s) => !s.self)) : null),
    acceptanceCriteria: acceptanceCount(storyText),
    uiStory: Boolean(uiStory),
    estimatedSize: declared.estimatedSize ?? null,
  };
}

// One record per plan attempt, accepted or rejected.
export function decisionRecord({ ts, key, decisionId, attempt, accepted, errors = [], agent = {}, raw = null, plan = null, storyText = '', uiStory = false }) {
  const source = plan ?? null;
  const subtasks = source
    ? source.subtasks.map((s) => ({ id: s.id, goal: s.goal, owns: s.owns, dependsOn: s.dependsOn ?? [], modelClass: s.modelClass, verify: s.verify, ...(s.decision ?? {}) }))
    : Array.isArray(raw?.subtasks)
      ? raw.subtasks.map((s) => ({ id: s?.id ?? null, goal: s?.goal ?? null, owns: s?.owns ?? null, dependsOn: s?.dependsOn ?? [], modelClass: s?.modelClass ?? null, verify: s?.verify ?? null, modelReason: s?.modelReason ?? null, verifyReason: s?.verifyReason ?? null, expectedFiles: s?.expectedFiles ?? null, expectedLoc: s?.expectedLoc ?? null, confidence: s?.confidence ?? null, alternatives: s?.alternatives ?? [] }))
      : [];
  return {
    ts,
    story: key,
    decisionId: accepted ? decisionId : null,
    attempt,
    accepted,
    rejectionReasons: accepted ? [] : errors,
    orchestrator: { cli: agent.cli ?? null, model: agent.model ?? null, promptVersion: agent.version ?? null },
    mode: source?.mode ?? raw?.mode ?? null,
    modeReason: source?.decision?.modeReason ?? raw?.modeReason ?? null,
    splitReason: source?.decision?.splitReason ?? raw?.splitReason ?? null,
    features: storyFeatures(storyText, source ?? (raw?.subtasks ? { subtasks: (raw.subtasks ?? []).filter(Boolean), decision: { features: raw.features ?? {} } } : null), { uiStory }),
    subtasks,
  };
}

const bySeverityCategory = (findings) => {
  const out = {};
  for (const f of findings ?? []) {
    const k = `${f.severity ?? 'blocking'}/${f.category ?? f.source ?? 'other'}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

// A round as recorded: its verdict and counts, never the findings' text.
export const roundRecord = ({ round, verdict, findings = [], diagnostics = null, outOfOwns = [], crossFindings = 0 }) => ({
  round,
  verdict,
  findings: bySeverityCategory(findings),
  diagnostics: diagnostics?.available ? { errors: diagnostics.errors.length, warnings: diagnostics.warnings.length } : null,
  outOfOwnsEdits: outOfOwns.length,
  crossSubtaskFindings: crossFindings,
});

// Findings in a subtask's rounds that point at files another subtask owns: a sign of a bad split.
export const crossFindings = (findings, others) => (findings ?? []).filter((f) => f.file && others.some((o) => matchesAny(f.file, o.owns ?? []))).length;

export function subtaskRunRecord(r) {
  return {
    ts: r.ts,
    story: r.key,
    decisionId: r.decisionId,
    subtaskId: r.subtaskId,
    implementer: { cli: r.implementer?.cli ?? null, model: r.implementer?.model ?? null, promptVersion: r.implementer?.version ?? null },
    verifier: { cli: r.verifier?.cli ?? null, model: r.verifier?.model ?? null, promptVersion: r.verifier?.version ?? null },
    modelClass: r.modelClass ?? null,
    verify: r.verify ?? null,
    maxRounds: r.maxRounds,
    rounds: r.rounds ?? [],
    approved: Boolean(r.approved),
    escalation: r.escalation ?? 'none',
    filesNeededOutsideOwns: r.filesNeededOutsideOwns ?? [],
    mergeConflictFiles: r.mergeConflictFiles ?? [],
    expected: { files: r.expected?.files ?? null, loc: r.expected?.loc ?? null },
    actual: { files: r.actual?.files ?? null, loc: r.actual?.loc ?? null },
    tokens: r.tokens ?? null,
    cost: r.cost ?? null,
    wallClockSec: r.wallClockSec ?? null,
    agentRuns: r.agentRuns ?? 0,
    leaseWaitSec: r.leaseWaitSec ?? 0,
    lspCalls: r.lspCalls ?? 0,
    signatureChangesWithoutReferences: Boolean(r.signatureChangesWithoutReferences),
  };
}

// Escaped defects: story-level review findings (with files) and files changed by QE bug fixes, credited
// to the subtask whose `owns` matches. What matches no subtask is recorded with subtaskId null.
export function attributeEscaped({ ts, key, decisionId, subtasks, source, findings = [], files = [] }) {
  const groups = new Map();
  const add = (id, kind, item) => {
    if (!groups.has(id)) groups.set(id, { findings: [], files: [] });
    groups.get(id)[kind].push(item);
  };
  const owner = (file) => subtasks.find((s) => !s.self && matchesAny(file, s.owns ?? []))?.id ?? (subtasks.length === 1 && subtasks[0].self ? subtasks[0].id : null);
  for (const f of findings) add(f.file ? owner(f.file) : null, 'findings', { severity: f.severity ?? null, category: f.category ?? null, file: f.file ?? null, issue: f.issue ?? f.detail ?? (typeof f === 'string' ? f : null) });
  for (const file of files) add(owner(file), 'files', file);
  return [...groups.entries()].map(([subtaskId, g]) => ({ ts, type: 'escaped', story: key, decisionId, subtaskId, source, findings: g.findings, files: g.files }));
}

export const storyOutcomeRecord = (r) => ({
  ts: r.ts,
  type: 'story',
  story: r.key,
  decisionId: r.decisionId ?? null,
  mode: r.mode ?? null,
  outcome: r.outcome,
  reason: r.reason ?? null,
  tokens: r.tokens ?? null,
  cost: r.cost ?? null,
  wallClockSec: r.wallClockSec,
  agentRuns: r.agentRuns ?? null,
  reviewBlocks: r.reviewBlocks ?? 0,
  bugFixCycles: r.bugFixCycles ?? 0,
  limitHit: r.limitHit ?? null,
  branch: r.branch ?? null,
  lspCalls: r.lspCalls ?? 0,
  signatureChangesWithoutReferences: Boolean(r.signatureChangesWithoutReferences),
});

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export const DEFAULT_THRESHOLDS = { smallDiffLoc: 60, tinySubtaskLoc: 40, tinySubtaskFiles: 3, selfMaxTotalLoc: 150, selfOverheadRunsPerSubtask: 2 };

// Labels per subtask of each accepted decision. Returns rows { story, decisionId, mode, subtaskId, ...,
// labels } plus one plan-level row per decision for should-have-been-self.
export function labelDecisions({ decisions = [], runs = [], outcomes = [] }, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const rows = [];
  for (const d of decisions.filter((x) => x.accepted && x.decisionId)) {
    const dRuns = runs.filter((r) => r.decisionId === d.decisionId);
    const escaped = outcomes.filter((o) => o.type === 'escaped' && o.decisionId === d.decisionId);
    const story = outcomes.find((o) => o.type === 'story' && o.decisionId === d.decisionId);
    for (const s of d.subtasks) {
      const run = dRuns.find((r) => r.subtaskId === s.id);
      const labels = [];
      if (run) {
        const rounds = run.rounds?.length ?? 0;
        const loc = run.actual?.loc;
        if (['large', 'medium'].includes(s.modelClass ?? run.modelClass) && run.approved && rounds === 1 && run.escalation === 'none' && loc != null && loc <= t.smallDiffLoc) labels.push('over-provisioned');
        if (run.escalation !== 'none' || (run.maxRounds && rounds >= run.maxRounds) || !run.approved) labels.push('under-provisioned');
        const outOfOwns = (run.rounds ?? []).reduce((n, r) => n + (r.outOfOwnsEdits ?? 0), 0);
        const cross = (run.rounds ?? []).reduce((n, r) => n + (r.crossSubtaskFindings ?? 0), 0);
        if (run.mergeConflictFiles?.length || run.filesNeededOutsideOwns?.length || outOfOwns || cross) labels.push('bad-split');
      }
      if (escaped.some((e) => e.subtaskId === s.id)) labels.push('weak-verification');
      rows.push({
        story: d.story,
        decisionId: d.decisionId,
        mode: d.mode,
        subtaskId: s.id,
        modelClass: s.modelClass,
        verify: s.verify,
        rounds: run?.rounds?.length ?? null,
        approved: run?.approved ?? null,
        escalation: run?.escalation ?? null,
        expectedLoc: s.expectedLoc ?? null,
        actualLoc: run?.actual?.loc ?? null,
        outcome: story?.outcome ?? null,
        labels,
      });
    }
    if (d.mode === 'delegate' && dRuns.length && dRuns.length === d.subtasks.length) {
      const tiny = dRuns.every((r) => r.actual?.loc != null && r.actual.loc <= t.tinySubtaskLoc && (r.actual.files ?? 0) <= t.tinySubtaskFiles);
      const total = dRuns.reduce((n, r) => n + (r.actual?.loc ?? 0), 0);
      const runsUsed = dRuns.reduce((n, r) => n + (r.agentRuns ?? 0), 0);
      if (tiny && total <= t.selfMaxTotalLoc && runsUsed > t.selfOverheadRunsPerSubtask * dRuns.length)
        rows.push({ story: d.story, decisionId: d.decisionId, mode: d.mode, subtaskId: '(plan)', modelClass: null, verify: null, rounds: null, approved: null, escalation: null, expectedLoc: null, actualLoc: total, outcome: story?.outcome ?? null, labels: ['should-have-been-self'] });
    }
  }
  return rows;
}

export function formatDecisionReport(rows) {
  if (!rows.length) return 'No orchestrator decisions recorded.';
  const head = `${'Story'.padEnd(10)} ${'Decision'.padEnd(9)} ${'Mode'.padEnd(8)} ${'Subtask'.padEnd(12)} ${'Model'.padEnd(7)} ${'Verify'.padEnd(6)} ${'Rnds'.padEnd(4)} ${'Esc'.padEnd(9)} ${'LOC exp/act'.padEnd(12)} Labels`;
  const lines = rows.map((r) =>
    [
      r.story.padEnd(10),
      String(r.decisionId).slice(0, 8).padEnd(9),
      String(r.mode ?? '-').padEnd(8),
      String(r.subtaskId).padEnd(12),
      String(r.modelClass ?? '-').padEnd(7),
      String(r.verify ?? '-').padEnd(6),
      String(r.rounds ?? '-').padEnd(4),
      String(r.escalation ?? '-').padEnd(9),
      `${r.expectedLoc ?? '-'}/${r.actualLoc ?? '-'}`.padEnd(12),
      r.labels.join(', ') || '-',
    ].join(' '),
  );
  const counts = Object.fromEntries(LABELS.map((l) => [l, rows.filter((r) => r.labels.includes(l)).length]));
  return `${head}\n${lines.join('\n')}\n\n${LABELS.map((l) => `${l}: ${counts[l]}`).join('  ')}`;
}

// ---------------------------------------------------------------------------------------------
// Late outcomes (recorded by the board stage when a story's card reaches Done)
// ---------------------------------------------------------------------------------------------

// Commits on the PR that the pipeline did not make: everything not reachable from the head the
// pipeline finished on. `lines` is null when a commit's stats are unknown.
export function humanCommitStats(commits, { isPipeline }) {
  const human = commits.filter((c) => !isPipeline(c));
  const known = human.filter((c) => c.lines != null);
  return { humanCommits: human.length, humanLines: known.length === human.length ? known.reduce((n, c) => n + c.lines, 0) : null, humanAuthors: [...new Set(human.flatMap((c) => c.authors ?? []))].sort() };
}

// BUG-* stories that name the key: defects found after the story shipped. (Reverts are a planned
// second signal: pass them as `reverts` once something detects them.)
export const bugStoriesFor = (key, stories) => stories.filter((s) => /^BUG-\d+$/.test(s.key) && s.key !== key && new RegExp(`\\b${key}\\b`).test(s.text)).map((s) => s.key);

export const lateOutcomeRecord = ({ ts, key, decisionId, pr, prMerged, stats, bugStories, reverts = null }) => ({
  ts,
  type: 'late',
  story: key,
  decisionId: decisionId ?? null,
  pr: pr ?? null,
  prMerged: Boolean(prMerged),
  humanCommits: stats?.humanCommits ?? null,
  humanLines: stats?.humanLines ?? null,
  humanAuthors: stats?.humanAuthors ?? [],
  bugStories: bugStories ?? [],
  reverts,
});
