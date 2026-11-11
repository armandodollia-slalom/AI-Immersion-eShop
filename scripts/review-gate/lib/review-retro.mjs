// The factory retro's review section: the pr-review records grouped by PR class, and proposals for the
// approvals policy table (`implement.reviewGate.approvals`). The retro only ever PROPOSES: the lessons
// run opens a PR that edits the table, which a person approves. Guards (enforced here, in code):
//   - a class needs at least `retro.minSample` closed PRs before anything is proposed for it;
//   - no PR that is not auto-merged is ever proposed fewer than 1 approval;
//   - widening auto-merge beyond Low is only ever a written proposal; the gate's rule is code.
import { approvalsFor } from './gate.mjs';
import { outcomeFor } from './pr-review.mjs';

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const rate = (n, d) => (d ? Math.round((n / d) * 100) / 100 : null);
const DEFAULTS = { minSample: 5, raiseFindRate: 0.3, raiseEscapeRate: 0.2, lowerFindRate: 0.05 };

// Per class: PRs, how often the 2nd and 3rd reviewers found something the earlier ones didn't, escapes
// by approval count, and review latency per number of reviewers.
export function reviewDigest(records, { table = {}, retro = {} } = {}) {
  const s = { ...DEFAULTS, ...retro };
  const reviews = records.filter((r) => r.type === 'pr-review');
  const byClass = new Map();
  for (const r of reviews) {
    const k = r.class ?? 'Unassessed';
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k).push({ ...r, outcome: outcomeFor(r, records) });
  }
  const classes = [...byClass.entries()].map(([cls, prs]) => {
    const nth = (n) => {
      const withN = prs.filter((p) => (p.reviewers ?? []).length >= n);
      return { prs: withN.length, foundNew: withN.filter((p) => p.reviewers[n - 1].foundNew).length, rate: rate(withN.filter((p) => p.reviewers[n - 1].foundNew).length, withN.length) };
    };
    const approvalCounts = [...new Set(prs.map((p) => p.approvals ?? 0))].sort((a, b) => a - b);
    const reviewerCounts = [...new Set(prs.map((p) => (p.reviewers ?? []).length))].sort((a, b) => a - b);
    return {
      class: cls,
      severity: prs[0].severity ?? null,
      prs: prs.length,
      merged: prs.filter((p) => p.merged).length,
      autoMerged: prs.filter((p) => p.gate?.autoMerged).length,
      requiredApprovals: approvalsFor(table, { cls, severity: prs[0].severity ?? cls.replace(/\+shared$/, '') }),
      firstReviewerFound: nth(1),
      secondReviewerFound: nth(2),
      thirdReviewerFound: nth(3),
      escapes: prs.filter((p) => p.outcome.escaped).length,
      escapesByApprovals: Object.fromEntries(approvalCounts.map((n) => {
        const g = prs.filter((p) => (p.approvals ?? 0) === n && p.merged);
        return [n, { prs: g.length, escapes: g.filter((p) => p.outcome.escaped).length, rate: rate(g.filter((p) => p.outcome.escaped).length, g.length) }];
      })),
      latencyByReviewers: Object.fromEntries(reviewerCounts.map((n) => {
        const g = prs.filter((p) => (p.reviewers ?? []).length === n);
        return [n, { prs: g.length, medianFirstReviewMin: median(g.map((p) => p.timeToFirstReviewMin)), medianMergeMin: median(g.map((p) => p.timeToMergeMin)) }];
      })),
    };
  });
  return { prs: reviews.length, classes, proposals: proposeApprovals(classes, table, s) };
}

// Proposals for the approvals table, one per class with enough data: raise when the extra reviewer
// keeps finding things or merged PRs escape at the current count; lower (never below 1) when the last
// required reviewer rarely finds anything and nothing escaped. Also a written-only proposal to widen
// auto-merge to a class whose reviews find nothing and whose PRs never escape.
export function proposeApprovals(classes, table, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const out = [];
  for (const c of classes) {
    const reviewed = c.prs - c.autoMerged;
    if (reviewed < s.minSample) continue;
    const current = c.requiredApprovals;
    const next = [c.firstReviewerFound, c.secondReviewerFound, c.thirdReviewerFound][current] ?? null;
    const last = [c.firstReviewerFound, c.secondReviewerFound, c.thirdReviewerFound][current - 1] ?? null;
    const atCurrent = c.escapesByApprovals[current] ?? { prs: 0, rate: null };
    if (next && next.prs >= s.minSample && next.rate >= s.raiseFindRate) {
      out.push({ class: c.class, kind: 'approvals', from: current, to: current + 1, why: `in ${next.prs} ${c.class} PRs with ${current + 1}+ reviewers, reviewer ${current + 1} found something the earlier ones didn't in ${Math.round(next.rate * 100)}%` });
    } else if (atCurrent.prs >= s.minSample && atCurrent.rate >= s.raiseEscapeRate) {
      out.push({ class: c.class, kind: 'approvals', from: current, to: current + 1, why: `${Math.round(atCurrent.rate * 100)}% of ${atCurrent.prs} merged ${c.class} PRs with ${current} approval(s) escaped (reopened after merge, follow-up bugs or reverts)` });
    } else if (current > 1 && last && last.prs >= s.minSample && last.rate <= s.lowerFindRate && c.escapes === 0) {
      out.push({ class: c.class, kind: 'approvals', from: current, to: Math.max(1, current - 1), why: `reviewer ${current} found something new in ${Math.round((last.rate ?? 0) * 100)}% of ${last.prs} ${c.class} PRs, and none escaped` });
    } else if (current === 1 && c.class !== 'Low' && c.escapes === 0 && c.firstReviewerFound.prs >= s.minSample && c.firstReviewerFound.rate <= s.lowerFindRate) {
      out.push({ class: c.class, kind: 'widen-auto-merge', from: 1, to: null, why: `reviewers found something in ${Math.round((c.firstReviewerFound.rate ?? 0) * 100)}% of ${c.firstReviewerFound.prs} ${c.class} PRs and none escaped: auto-merge could be widened to ${c.class}. A code change to the gate's rule (lib/gate.mjs), for a person to decide; the retro never makes it` });
    }
  }
  return out.map((p) => (p.kind === 'approvals' ? { ...p, to: Math.max(1, p.to) } : p));
}

// The approvals table with the proposals applied (only `approvals` proposals; never below 1).
export function applyProposals(table, proposals) {
  const next = { ...table };
  for (const p of proposals.filter((x) => x.kind === 'approvals')) next[p.class] = Math.max(1, p.to);
  return next;
}
