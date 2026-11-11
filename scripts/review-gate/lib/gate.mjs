// The gate: from an assessment, decide whether the PR may auto-merge, must wait for its checks, or
// needs people, and apply that to the PR (labels, reviewer requests, the review notice).
//
// Auto-merge only when the PR severity is Low, every ticket has high confidence, no ticket has a human
// reopen, and the checks pass (and implement.autoMerge.enabled). Everything else needs at least one
// approval: the PR gets `approvals:N` (N from the approvals policy table, never below 1) and
// `needs-human`, reviews are requested from the tickets' assignees (or the CODEOWNERS of the systems a
// ticket touches when it has none), and a comment says exactly what triggered the review. Once a PR
// needs people it stays that way (`required` is sticky), so the gate never merges a PR a person was
// asked to review. CODEOWNERS stay optional reviewers on every PR: the gate only sets how many
// approvals are required.
import { describeSignals } from './confidence.mjs';
import { addIssueLabel, editPrLabels, findComment, requestReviewers, upsertComment } from './github.mjs';
import { ownersOfFiles } from './systems.mjs';

export const MARKER = 'review-gate:';
const MARKER_RE = /<!-- review-gate:(\{.*?\}) -->/;
export const encodeState = (s) => `<!-- review-gate:${JSON.stringify(s).replace(/--/g, '-\\u002d')} -->`;
export function parseState(body) {
  const m = MARKER_RE.exec(body ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const list = (keys) => (keys.length <= 1 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`);

// The approvals a PR of this class needs: the policy table's entry for the class (e.g. "High+shared"),
// else for its severity, else `default`; never fewer than 1 for a PR that does not auto-merge.
export function approvalsFor(table, { cls, severity }) {
  const n = [table?.[cls], table?.[severity], table?.default, 1].find((v) => Number.isInteger(v));
  return Math.max(1, n);
}

// A ticket's confidence problems, with CI left to the PR-level decision (pending CI is a wait, not a
// review; failing CI is a PR-level trigger).
const confidenceProblems = (t) => (t.confidence?.reasons ?? []).filter((r) => !/^CI /.test(r));

// { action: 'auto-merge' | 'wait' | 'review', approvals, triggers: [text], wouldAutoMerge: [keys], reasons }
export function decideGate(a, { settings, autoMerge, prior = null }) {
  const triggers = [];
  const okTickets = [];
  for (const t of a.tickets) {
    const own = [];
    if (!t.severity?.level) own.push(`${t.key} was not assessed${a.errors?.length ? ` (${a.errors[0]})` : ''}`);
    else if (t.severity.level !== 'Low') own.push(`${t.key} is ${t.severity.level} (${[...(t.systems?.length ? [t.systems.join(', ')] : []), t.severity.explanation].join('; ')})`);
    const conf = confidenceProblems(t);
    if (t.severity?.level && conf.length) own.push(`${t.key} has confidence ${t.confidence.score} (${conf.join('; ')})`);
    if (t.reopens?.length) own.push(`${t.key} has ${t.reopens.length} human reopen(s)`);
    if (own.length) triggers.push(...own);
    else okTickets.push(t.key);
  }
  // PR-level reasons the tickets alone do not explain: several systems, shared infrastructure, a contract.
  if (a.severity?.level && a.severity.level !== 'Low' && !a.tickets.some((t) => t.severity?.level && t.severity.level !== 'Low')) triggers.push(`the PR is ${a.severity.level}: ${a.severity.explanation}`);
  else if (a.severity?.level && (a.severity.bumped || a.severity.floor)) triggers.push(`PR severity ${a.severity.level}: ${a.severity.explanation}`);
  if (a.ci === 'failure') triggers.push('the PR\'s checks are failing');
  if (prior?.required) triggers.push(...(prior.triggers ?? []).filter((x) => !triggers.includes(x)));
  if (prior?.headSha && a.headSha && prior.headSha !== a.headSha && prior.action === 'wait') triggers.push('the PR changed after it was assessed');

  if (!triggers.length) {
    if (a.ci !== 'success') return { action: 'wait', approvals: 0, triggers, wouldAutoMerge: okTickets, reasons: [`waiting for the PR's checks (${a.ci ?? 'none reported yet'})`] };
    if (!autoMerge?.enabled) {
      const off = 'auto-merge is switched off (implement.autoMerge.enabled); it would have auto-merged';
      return { action: 'review', approvals: approvalsFor(settings.approvals, { cls: a.class, severity: a.severity.level }), triggers: [off], wouldAutoMerge: okTickets, reasons: [off] };
    }
    return { action: 'auto-merge', approvals: 0, triggers, wouldAutoMerge: okTickets, reasons: ['PR severity Low, every ticket high confidence, no human reopens, checks green'] };
  }
  const approvals = approvalsFor(settings.approvals, { cls: a.class, severity: a.severity?.level ?? 'Severe' });
  const would = okTickets.length && okTickets.length < a.tickets.length ? [`${list(okTickets)} would have auto-merged`] : [];
  return { action: 'review', approvals, triggers, wouldAutoMerge: okTickets, reasons: [...triggers, ...would] };
}

// ---------------------------------------------------------------------------------------------
// The review notice (one PR comment, edited in place, carrying the gate's state)
// ---------------------------------------------------------------------------------------------

const cell = (s) => String(s ?? '-').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '-';

export function gateState(a, d, prior = null, extra = {}) {
  return {
    v: 1,
    action: d.action,
    approvals: d.approvals,
    required: Boolean(prior?.required) || d.action === 'review',
    triggers: d.triggers,
    headSha: a.headSha,
    class: a.class,
    severity: a.severity?.level ?? null,
    systems: { names: a.systems?.names ?? [], shared: Boolean(a.systems?.shared), contract: Boolean(a.systems?.contract) },
    tickets: a.tickets.map((t) => ({ key: t.key, issue: t.issue?.number ?? null, severity: t.severity?.level ?? null, high: Boolean(t.confidence?.high), reopens: t.reopens?.length ?? 0 })),
    countedReviews: prior?.countedReviews ?? [],
    assessedAt: a.assessedAt,
    ...extra,
  };
}

export function renderNotice(a, d, state) {
  const head = {
    review: `## Review gate: ${d.approvals} approval${d.approvals === 1 ? '' : 's'} required`,
    wait: '## Review gate: waiting for the checks',
    'auto-merge': '## Review gate: auto-merge',
  }[d.action];
  const lines = [head, ''];
  if (d.action === 'review') lines.push(`**What triggered review:** ${d.triggers.join('; ')}.${d.wouldAutoMerge.length && d.wouldAutoMerge.length < a.tickets.length ? ` ${list(d.wouldAutoMerge)} would have auto-merged.` : ''}`, '');
  if (d.action === 'wait') lines.push(`Every ticket qualifies for auto-merge; the gate merges the PR once its checks pass (\`board sync\` checks again). ${d.reasons.join('; ')}.`, '');
  if (d.action === 'auto-merge') lines.push(`${d.reasons.join('; ')}. Merged with \`gh pr merge --auto\`; the cards reach Done through \`board sync\` once GitHub closes the issues.`, '');
  lines.push('| Ticket | Impact | Complexity | Fix risk | Severity | Confidence | Systems |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of a.tickets) lines.push(`| ${t.key} | ${cell(t.impact)} | ${cell(t.complexity)} | ${cell(t.fixRisk)} | **${cell(t.severity?.level ?? 'not assessed')}** | ${t.confidence?.score ?? '-'}${t.confidence?.high ? ' (high)' : ''} | ${cell(t.systems?.join(', ') || 'none')} |`);
  lines.push('');
  for (const t of a.tickets) {
    lines.push(`<details><summary>${t.key}: how it was rated</summary>`, '');
    lines.push(`- **Severity:** ${t.severity?.explanation ?? 'not assessed'}`);
    for (const [f, label] of [['impact', 'Impact'], ['complexity', 'Complexity'], ['fixRisk', 'Fix risk']]) if (t[`${f}Reason`]) lines.push(`- **${label} ${t[f]}:** ${t[`${f}Reason`].replace(/\s+/g, ' ')}`);
    lines.push(`- **Confidence ${t.confidence?.score ?? '-'}:** ${describeSignals(t.signals ?? {}, t.confidence?.criteria ?? {}).join('; ')}; the agent's own estimate ${t.agentConfidence ?? 'none'}`);
    if (t.reopens?.length) lines.push(`- **Human reopens:** ${t.reopens.length}`);
    lines.push('', '</details>', '');
  }
  lines.push(`**PR severity:** ${a.severity?.level ?? 'unknown'} (${a.severity?.explanation ?? '-'}) · class \`${a.class}\` · systems: ${a.systems?.names?.join(', ') || 'none'} · checks: ${a.ci ?? 'none yet'}`, '');
  if (d.action === 'review') lines.push(`The \`review-quorum\` check counts approvals from distinct people, given on the latest push; the PR's author approves with a Comment review whose body is \`/approve\` (GitHub does not let authors click Approve). Anyone can add more reviewers; the gate only sets how many approvals are required. A "changes requested" review counts as a human reopen of the tickets it names (or all of them), which raises their severity.`, '');
  lines.push(encodeState(state));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Applying the decision to the PR
// ---------------------------------------------------------------------------------------------

export const approvalsLabel = (settings, n) => (settings.labels?.approvals ?? 'approvals:{n}').replace('{n}', String(n));

// Reviewers: each ticket's assignees, or the CODEOWNERS of the files it touches when it has none.
// Never the PR's author (GitHub refuses that).
export function reviewersFor(a, { assignees, codeowners, author }) {
  const out = [];
  for (const t of a.tickets) {
    const mine = assignees[t.key] ?? [];
    out.push(...(mine.length ? mine : ownersOfFiles(t.paths ?? [], codeowners)));
  }
  return [...new Set(out)].filter((l) => l && l.toLowerCase() !== String(author ?? '').toLowerCase());
}

// The gate state on the PR (its notice's marker), or null.
export function readPrState(gh, repo, pr) {
  return parseState(findComment(gh, repo, pr, MARKER)?.body);
}

// Labels, reviewers and the notice for a PR that needs people, or just the notice otherwise. Returns
// { reviewers, problems }.
export function applyReview(config, gh, a, d, state, { assignees, codeowners, author, currentLabels = [] }) {
  const s = config.implement.reviewGate;
  const repo = config.board.repo;
  const problems = [];
  let reviewers = [];
  const attempt = (what, fn) => {
    try {
      return fn();
    } catch (error) {
      problems.push(`${what}: ${error.message.split('\n')[0]}`);
      return null;
    }
  };
  // Every gated PR carries `approvals:N` (approvals:0 while it waits for its checks or auto-merges), so
  // `board sync` finds it again and the review-quorum check knows the count.
  const want = approvalsLabel(s, d.action === 'review' ? d.approvals : 0);
  const prefix = approvalsLabel(s, '');
  const stale = currentLabels.filter((l) => l.startsWith(prefix) && l !== want);
  if (d.action === 'review') {
    attempt('labels', () => editPrLabels(gh, repo, a.pr, { add: [want, s.labels?.needsHuman ?? 'needs-human'], remove: stale }));
    reviewers = attempt('reviewers', () => requestReviewers(gh, repo, a.pr, reviewersFor(a, { assignees, codeowners, author }))) ?? [];
  } else if (!currentLabels.includes(want) || stale.length) attempt('labels', () => editPrLabels(gh, repo, a.pr, { add: currentLabels.includes(want) ? [] : [want], remove: stale }));
  attempt('notice', () => upsertComment(gh, repo, a.pr, MARKER, renderNotice(a, d, { ...state, reviewers })));
  return { reviewers, problems };
}

// Marks the tickets of a reopened PR on their issues (the `reopened` label) so people and requeue see it.
export function labelReopened(config, gh, tickets) {
  const label = config.implement.reviewGate.labels?.reopened ?? 'reopened';
  for (const t of tickets) if (t.issue?.number ?? t.issue) addIssueLabel(gh, config.board.repo, t.issue?.number ?? t.issue, label);
}
