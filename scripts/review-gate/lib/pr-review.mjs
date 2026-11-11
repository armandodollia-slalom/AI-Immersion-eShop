// Review data for the factory retro: when a gated PR closes, `board sync` writes one `type: "pr-review"`
// record to decision-outcomes.jsonl (next to the `late` records): the PR's class features, how people
// reviewed it, and what was known of its outcome then. The outcome is filled in later by joining the
// `reopen`, `late` and `revert` records on the PR's tickets (outcomeFor), so the record never changes.

const ms = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60_000) : null);
const loginOf = (x) => x?.user?.login ?? x?.author?.login ?? x?.author ?? null;
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED']);
const TRIVIAL = /^\s*(lgtm|looks good( to me)?|ship it|thanks?|ty|\+1|👍|nit\b)/i;

// A comment worth counting: long enough (`substantiveCommentChars`) and not a plain approval or a nit.
export const substantive = (text, min = 20) => String(text ?? '').trim().length >= min && !TRIVIAL.test(String(text ?? ''));

// Per reviewer, in the order they first reviewed: their verdicts, substantive comments, the files they
// commented on, whether a commit followed their feedback, and whether they found something no earlier
// reviewer had (a substantive comment on a file no earlier reviewer commented on, or substantive
// feedback that led to a commit when the earlier reviewers left none). A heuristic: the retro reads
// rates over many PRs, not single verdicts.
export function reviewersOf({ reviews = [], comments = [], commits = [], author = null, min = 20 }) {
  const people = new Map();
  const touch = (login, at) => {
    if (!login || login === author) return null;
    if (!people.has(login)) people.set(login, { login, firstAt: at, verdicts: [], substantiveComments: 0, files: new Set(), feedbackAt: null });
    const p = people.get(login);
    if (at && (!p.firstAt || at < p.firstAt)) p.firstAt = at;
    return p;
  };
  const feedback = (p, at) => (p.feedbackAt = !p.feedbackAt || at < p.feedbackAt ? at : p.feedbackAt);
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
    const p = touch(loginOf(r), r.submitted_at);
    if (!p || !DECISIVE.has(r.state)) continue;
    if (r.state !== 'COMMENTED' || substantive(r.body, min)) p.verdicts.push(r.state);
    if (substantive(r.body, min)) {
      p.substantiveComments++;
      feedback(p, r.submitted_at);
    }
    if (r.state === 'CHANGES_REQUESTED') feedback(p, r.submitted_at);
  }
  for (const c of comments) {
    const p = touch(loginOf(c), c.created_at);
    if (!p || !substantive(c.body, min)) continue;
    p.substantiveComments++;
    if (c.path) p.files.add(c.path);
    feedback(p, c.created_at);
  }
  const commitTimes = commits.map((c) => c.commit?.committer?.date ?? c.commit?.author?.date ?? c.committedDate).filter(Boolean);
  const ordered = [...people.values()].sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
  const earlierFiles = new Set();
  let earlierFeedback = false;
  return ordered.map((p, i) => {
    const ledToCommits = Boolean(p.feedbackAt && commitTimes.some((t) => t > p.feedbackAt));
    const newFiles = [...p.files].filter((f) => !earlierFiles.has(f));
    const foundNew = p.substantiveComments > 0 && (newFiles.length > 0 || (ledToCommits && !earlierFeedback));
    for (const f of p.files) earlierFiles.add(f);
    earlierFeedback ||= p.substantiveComments > 0;
    return { login: p.login, order: i + 1, firstAt: p.firstAt, verdicts: p.verdicts, substantiveComments: p.substantiveComments, ledToCommits, foundNew };
  });
}

// The record for a closed gated PR. `view` is the PR (gh pr view fields), `state` its gate state,
// `triages` the tickets' triage data, `reviews`, `comments`, `commits` the PR's (REST shapes).
export function prReviewRecord({ ts, view, state, triages = [], reviews = [], comments = [], commits = [], min = 20 }) {
  const reviewers = reviewersOf({ reviews, comments, commits, author: view.author, min });
  const approvers = new Set(reviews.filter((r) => r.state === 'APPROVED' && loginOf(r) !== view.author).map(loginOf));
  const firstReview = reviews.map((r) => r.submitted_at).filter(Boolean).sort()[0] ?? null;
  const after = commits.filter((c) => (c.commit?.committer?.date ?? c.committedDate ?? '') > (view.createdAt ?? ''));
  const tickets = (state.tickets ?? []).map((t) => {
    const tr = triages.find((x) => x?.key === t.key) ?? {};
    return { key: t.key, impact: tr.impact ?? null, complexity: tr.complexity ?? null, fixRisk: tr.fixRisk ?? null, severity: tr.severity?.level ?? t.severity ?? null, confidence: tr.confidence?.score ?? null, high: Boolean(tr.confidence?.high ?? t.high), reopensBeforeMerge: (tr.reopens ?? []).filter((r) => !r.afterMerge).length };
  });
  const scores = tickets.map((t) => t.confidence).filter((x) => x != null);
  return {
    ts,
    type: 'pr-review',
    pr: view.url,
    number: view.number,
    merged: view.state === 'MERGED',
    createdAt: view.createdAt ?? null,
    mergedAt: view.mergedAt ?? null,
    closedAt: view.closedAt ?? null,
    mergeCommit: view.mergeCommit?.oid ?? null,
    // The PR class features.
    class: state.class ?? null,
    severity: state.severity ?? null,
    tickets,
    stories: tickets.map((t) => t.key),
    ticketCount: tickets.length,
    systems: state.systems?.names ?? [],
    systemCount: state.systems?.names?.length ?? 0,
    shared: Boolean(state.systems?.shared || state.systems?.contract),
    contract: Boolean(state.systems?.contract),
    overridePaths: [...new Set(triages.flatMap((t) => (t?.floorReasons ?? []).filter((r) => !r.startsWith('category '))))],
    diff: { additions: view.additions ?? null, deletions: view.deletions ?? null, files: view.changedFiles ?? null },
    confidence: scores.length ? Math.min(...scores) : null,
    // The review.
    gate: { action: state.action ?? null, autoMerged: state.action === 'auto-merge' },
    requiredApprovals: state.action === 'review' ? state.approvals ?? 1 : 0,
    approvals: approvers.size,
    reviewers,
    changesRequestedRounds: reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length,
    timeToFirstReviewMin: ms(view.createdAt, firstReview),
    timeToMergeMin: ms(view.createdAt, view.mergedAt),
    commitsAfterOpen: after.length,
    humanCommits: after.filter((c) => (c.author?.login ?? null) !== view.author).length,
    // The outcome known at close; later outcomes are joined in by outcomeFor.
    outcome: { reopensAfterMerge: 0, followUpBugs: [], reverts: 0 },
  };
}

// The outcome of a pr-review record from the later records: reopens after the merge of its tickets,
// BUG-* tickets that name them (late records), and reverts of its merge.
export function outcomeFor(rec, records) {
  const keys = new Set(rec.stories ?? []);
  const since = rec.mergedAt ?? rec.closedAt ?? rec.ts;
  const reopensAfterMerge = records.filter((r) => r.type === 'reopen' && keys.has(r.story) && (r.afterMerge || (since && r.ts > since))).length;
  const followUpBugs = [...new Set(records.filter((r) => r.type === 'late' && keys.has(r.story)).flatMap((r) => r.bugStories ?? []))].filter((k) => !keys.has(k));
  const reverts = records.filter((r) => r.type === 'revert' && r.pr === rec.pr).length;
  return { reopensAfterMerge, followUpBugs, reverts, escaped: reopensAfterMerge > 0 || followUpBugs.length > 0 || reverts > 0 };
}

// Reverts of a merge on the base branch's log ([{ sha, subject, body }]): "This reverts commit <sha>",
// or a subject `Revert "<title>"`.
export function revertsOf(rec, log, title) {
  return log.filter((c) => (rec.mergeCommit && String(c.body ?? '').includes(`This reverts commit ${rec.mergeCommit}`)) || (title && String(c.subject ?? '').startsWith(`Revert "${title}`)));
}
