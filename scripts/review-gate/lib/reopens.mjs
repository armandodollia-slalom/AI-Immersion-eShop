// Human reopens of a triaged bug ticket, counted apart from QE's bug-fix cycles. `board sync` finds them:
//   card              the card moved back to In Progress from Pending Review or Done with no pipeline
//                     event behind it (the last pipeline event on the card left it in review or done)
//   issue             the issue was reopened (it sits open in Done, closed earlier)
//   changes-requested a "changes requested" review on the PR, against the tickets it names (or all the
//                     PR's tickets when it names none); each review counts once
// The board is a user project, so projects_v2_item webhooks don't fire and Actions can't watch lane
// moves: the sync compares the card with the last pipeline event instead.
//
// Each reopen bumps the ticket's severity by one level (capped at Severe) and blocks auto-merge for it
// for good. Before its PR merges, the PR's gate goes to review and the ticket re-runs on its branch;
// after the merge, the ticket re-runs as a follow-up PR through the same gate.
import { ticketSeverity } from './severity.mjs';

const KEY = /\b([A-Z][A-Z0-9]*-\d+)\b/g;

// The reopen a card shows, or null. `item`: { column, state, stateReason }; `marker`: the last
// pipeline event marker on the issue ({ event, column }).
export function cardReopen(item, marker) {
  const left = marker?.column ?? null;
  if (!['review', 'done'].includes(left)) return null;
  if (item.column === 'inProgress') return { source: 'card', detail: `card moved from ${left === 'review' ? 'Pending Review' : 'Done'} back to In Progress` };
  if (item.state === 'OPEN' && item.column === 'done' && item.stateReason === 'REOPENED') return { source: 'issue', detail: 'issue reopened' };
  return null;
}

// The tickets a "changes requested" review names (in its body or its inline comments), else all of them.
export function reviewTargets(review, comments, keys) {
  const text = [review.body ?? '', ...comments.filter((c) => c.pull_request_review_id === review.id).map((c) => `${c.path ?? ''} ${c.body ?? ''}`)].join('\n');
  const named = [...new Set([...text.matchAll(KEY)].map((m) => m[1]).filter((k) => keys.includes(k)))];
  return named.length ? named : keys;
}

// The "changes requested" reviews not counted yet: [{ review, keys, feedback }].
export function newChangesRequested(reviews, comments, keys, counted = []) {
  const seen = new Set((counted ?? []).map(String));
  return (reviews ?? [])
    .filter((r) => r.state === 'CHANGES_REQUESTED' && !seen.has(String(r.id)))
    .map((r) => ({ review: r, keys: reviewTargets(r, comments ?? [], keys), feedback: reviewFeedback(r, comments ?? []) }));
}

// What the reviewer asked for, for the re-run: the review body and its inline comments.
export function reviewFeedback(review, comments, max = 4000) {
  const inline = comments.filter((c) => c.pull_request_review_id === review.id).map((c) => `- \`${c.path}${c.line ? `:${c.line}` : ''}\`: ${String(c.body ?? '').replace(/\s+/g, ' ').trim()}`);
  const text = [String(review.body ?? '').trim(), ...inline].filter(Boolean).join('\n');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The triage data with one more reopen: severity recomputed from the stored ratings and floor.
export function withReopen(triage, reopen, settings) {
  const reopens = [...(triage.reopens ?? []), reopen];
  const severity = ticketSeverity({ impact: triage.impact, complexity: triage.complexity, fixRisk: triage.fixRisk, floorReasons: triage.floorReasons ?? [], reopens: reopens.length }, settings);
  return { ...triage, reopens, severity };
}

// The note added to the ticket's `## Decisions` for the re-run: binding, like a human's answers.
export function reopenDecisionNote(reopen) {
  const who = reopen.by ? ` by @${reopen.by}` : '';
  const where = reopen.pr ? ` on ${reopen.pr}` : '';
  const head = reopen.source === 'changes-requested' ? `Changes requested${who}${where}` : reopen.source === 'issue' ? `Issue reopened${who}` : `Card moved back to In Progress${who}`;
  return `Human reopen (${head}${reopen.afterMerge ? ', after the PR merged' : ''}): ${reopen.feedback ? reopen.feedback.replace(/\s+/g, ' ').trim() : 'no reason given; see the latest comments on this issue and its PR.'}`;
}
