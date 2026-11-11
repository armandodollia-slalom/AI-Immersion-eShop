// The factory retro: a bounded digest of the decision log (.agent-metrics/decisions.jsonl) since the
// last lessons run, so the qe-lessons agent can see *why* agents decided what they did and propose
// improvements anywhere in the factory (agent definitions, docs, story template, policies), not
// only the per-agent lessons files.
import { git, revExists } from '../../pipeline/lib/git.mjs';

const take = (list, n) => list.slice(-n);
const key = (...parts) => parts.map((p) => p ?? '').join('\u0000');

function group(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const k = keyOf(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return [...map.values()];
}

// Start of the retro window: the last lessons commit on the base branch, else `windowDays` ago.
export function retroSince(config, now = Date.now()) {
  const fallback = new Date(now - (config.lessons.retro?.windowDays ?? config.lessons.intervalDays) * 86_400_000).toISOString();
  if (!revExists(config.root, config.baseRef)) return fallback;
  const last = git(config.root, ['log', '-1', '--format=%cI', '--grep=Update agent lessons', config.baseRef]).stdout.trim();
  return last ? new Date(last).toISOString() : fallback;
}

// Every decision in the window, grouped by the question it answers. Empty `counts` means nothing to review.
export function retroDigest(config, decisions, since) {
  const n = config.lessons.examplesPerCategory;
  const recent = decisions.filter((d) => !since || d.ts > since);
  const of = (stage) => recent.filter((d) => d.stage === stage);

  // Latest "## Why" per case, so later findings about a case can be read next to the reason it was written.
  const why = new Map();
  for (const d of of('plan')) for (const item of d.items ?? []) why.set(key(d.story, item.case), item.reason);
  const withWhy = (story, item) => ({ story, case: item.case, why_written: why.get(key(story, item.case)) ?? null });

  const plans = group(of('plan'), (d) => d.story).map((ds) => {
    const last = ds.at(-1);
    return { story: last.story, rounds: ds.length, cases: (last.items ?? []).length, summary: last.reason, excluded: last.excluded ?? [] };
  });
  const verifyGaps = of('plan-verify').flatMap((d) => (d.items ?? []).map((item) => ({ ...withWhy(d.story, item), category: item.category, subtype: item.subtype, reason: item.reason })));
  const tracedToPlan = of('automation-verify').flatMap((d) =>
    (d.items ?? []).filter((i) => i.root_stage === 'plan').map((item) => ({ ...withWhy(d.story, item), category: item.category, reason: item.reason })),
  );
  const bugs = of('automation').flatMap((d) => (d.items ?? []).map((item) => ({ ...withWhy(d.story, item), expected: item.expected, actual: item.actual, location: item.location, reason: item.reason })));

  const findingGroups = (decisionsOf, keyOf) =>
    group(
      decisionsOf.flatMap((d) => (d.items ?? []).map((item) => ({ ...item, story: d.story, agent: d.agent, decision: d.decision }))),
      keyOf,
    )
      .map((items) => ({
        ...Object.fromEntries(Object.entries(items[0]).filter(([k]) => ['agent', 'category', 'subtype', 'rule', 'severity'].includes(k))),
        count: items.length,
        stories: new Set(items.map((i) => i.story)).size,
        examples: take(items, n).map(({ story, case: c, file, line, reason, fix, location }) => ({ story, case: c, location: location ?? (file ? `${file}${line ? `:${line}` : ''}` : null), reason, fix })),
      }))
      .sort((a, b) => b.stories - a.stories || b.count - a.count);

  const reviews = of('review');
  const blocked = reviews.filter((d) => d.decision !== 'approved');
  const digest = {
    since,
    counts: Object.fromEntries(group(recent, (d) => key(d.stage, d.decision)).map((ds) => [`${ds[0].stage}:${ds[0].decision}`, ds.length])),
    // 1. Ticket to test cases: why the plan agent wrote (and left out) what it did, and how those cases fared.
    plans: {
      stories: take(plans, n * 2),
      verifierGaps: findingGroups(of('plan-verify'), (i) => key(i.category, i.subtype)).slice(0, n * 2),
      casesTracedBackToPlan: take(tracedToPlan, n * 2),
      casesThatCaughtBugs: take(bugs.map(({ story, case: c, why_written }) => ({ story, case: c, why_written })), n * 2),
      gapExamples: take(verifyGaps, n),
    },
    // 2. Why the architecture review blocked (or approved) the implementer.
    review: {
      blocked: findingGroups(blocked, (i) => key(i.agent, i.rule ?? i.category, i.severity)).slice(0, n * 2),
      blockedSummaries: take(blocked.map((d) => ({ story: d.story, round: d.round, agent: d.agent, reason: d.reason })), n),
      approvals: take(reviews.filter((d) => d.decision === 'approved').map((d) => ({ story: d.story, round: d.round, agent: d.agent, reason: d.reason })), n),
    },
    // 3. Why the automation verifier denied the QE agent's tests.
    automation: {
      verifierGaps: findingGroups(of('automation-verify').filter((d) => d.decision === 'denied'), (i) => key(i.category, i.subtype, i.subject)).slice(0, n * 2),
      deniedSummaries: take(of('automation-verify').filter((d) => d.decision === 'denied').map((d) => ({ story: d.story, round: d.round, score: d.score, reason: d.reason })), n),
    },
    // 4. Why the integration tests failed the implementer's code.
    productBugs: take(bugs, n * 2),
    // 5. How the orchestrator split stories into subtasks (and why), and why the pair verifiers sent
    //    subtasks back: model, verification and split choices next to how they fared.
    implement: {
      plans: take(
        of('implement-plan')
          .filter((d) => ['plan-written', 'plan-rejected', 'blocked'].includes(d.decision))
          .map((d) => ({ story: d.story, decision: d.decision, mode: d.mode ?? null, reason: d.reason, subtasks: (d.items ?? []).map(({ id, modelClass, modelReason, verify, verifyReason, confidence }) => ({ id, modelClass, modelReason, verify, verifyReason, confidence })) })),
        n * 2,
      ),
      escalations: take(of('implement-plan').filter((d) => d.decision?.startsWith('escalation-') || d.decision === 'gave-up').map((d) => ({ story: d.story, subtask: d.subtask, decision: d.decision, pairOutcome: d.pair_outcome, reason: d.reason })), n),
      verifierFindings: findingGroups(of('implement-verify').filter((d) => d.decision !== 'approved'), (i) => key(i.agent, i.category, i.severity)).slice(0, n * 2),
    },
  };
  return digest;
}

export const digestIsEmpty = (digest) => Object.keys(digest.counts).length === 0;
