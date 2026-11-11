// Auto-merge of a PR the gate cleared (PR severity Low, every ticket high confidence, no human reopens,
// checks green, `implement.autoMerge.enabled`). Every merge goes through mergePr (github.mjs), which
// picks the identity (`implement.autoMerge.identity`: gh-user today, a GitHub App with a ruleset bypass
// once approvals from people are required). The PR is labeled `auto-merged`; its cards reach Done
// through the existing `closed` event of `board sync` once GitHub closes the issues.
import { MARKER, applyReview, approvalsLabel, renderNotice } from './gate.mjs';
import { editPrLabels, mergePr, upsertComment } from './github.mjs';

// Merges and records it, or, when GitHub refuses, sends the PR to review with the reason.
// Returns { decision, state, merged, problems }.
export function autoMergePr(config, gh, a, decision, state, reviewContext) {
  const s = config.implement.reviewGate;
  const repo = config.board.repo;
  try {
    const how = mergePr(gh, repo, a.pr, config.implement.autoMerge);
    const merged = { ...state, action: 'auto-merge', merge: { identity: how.identity, method: how.method } };
    const problems = [];
    try {
      const zero = approvalsLabel(s, 0);
      const stale = (reviewContext.currentLabels ?? []).filter((l) => l.startsWith(approvalsLabel(s, '')) && l !== zero);
      editPrLabels(gh, repo, a.pr, { add: [s.labels?.autoMerged ?? 'auto-merged', zero], remove: stale });
    } catch (error) {
      problems.push(`label: ${error.message.split('\n')[0]}`);
    }
    try {
      upsertComment(gh, repo, a.pr, MARKER, renderNotice(a, decision, merged));
    } catch (error) {
      problems.push(`notice: ${error.message.split('\n')[0]}`);
    }
    return { decision, state: merged, merged: true, problems };
  } catch (error) {
    const reason = `auto-merge failed (${error.message.split('\n')[0]})`;
    const review = { ...decision, action: 'review', approvals: Math.max(1, decision.approvals || 1), triggers: [reason], reasons: [reason] };
    const next = { ...state, action: 'review', approvals: review.approvals, required: true, triggers: [reason] };
    const applied = applyReview(config, gh, a, review, next, reviewContext);
    return { decision: review, state: next, merged: false, problems: [reason, ...applied.problems] };
  }
}
