// The `review-quorum` check: a PR labeled `approvals:N` passes once N distinct people other than its
// author approve it on its latest push. GitHub rulesets set one approval count per branch, not per PR,
// so the gate sets the count per PR with this label and the check enforces it. A PR without the label,
// or with `approvals:0`, passes.

// N from the PR's labels: the highest `approvals:N` (null when there is none).
export function requiredApprovals(labels, pattern = 'approvals:{n}') {
  const [pre, post] = pattern.split('{n}');
  const ns = (labels ?? [])
    .map((l) => String(l?.name ?? l))
    .filter((l) => l.startsWith(pre) && l.endsWith(post ?? ''))
    .map((l) => Number(l.slice(pre.length, l.length - (post ?? '').length)))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return ns.length ? Math.max(...ns) : null;
}

// reviews: GitHub's review objects ({ user: { login }, state, commit_id, submitted_at }), oldest first.
// Each reviewer's latest decisive review (APPROVED, CHANGES_REQUESTED or DISMISSED; comments do not
// change a verdict) counts, and an approval counts only when it was given on the head commit (an
// approval from before the latest push is stale).
export function quorum({ labels, reviews, author, headSha, pattern }) {
  const required = requiredApprovals(labels, pattern);
  const latest = new Map();
  for (const r of [...(reviews ?? [])].sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')))) {
    const login = r.user?.login ?? r.author?.login ?? null;
    if (!login || login === author || r.user?.type === 'Bot') continue;
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(login, r);
  }
  const approvers = [...latest.values()].filter((r) => r.state === 'APPROVED' && (!headSha || r.commit_id === headSha)).map((r) => r.user?.login ?? r.author?.login);
  const stale = [...latest.values()].filter((r) => r.state === 'APPROVED' && headSha && r.commit_id !== headSha).map((r) => r.user?.login ?? r.author?.login);
  const blocking = [...latest.values()].filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.user?.login ?? r.author?.login);
  const pass = !required || approvers.length >= required;
  const summary = !required
    ? 'no approvals:N label (or approvals:0): nothing to enforce'
    : `${approvers.length} of ${required} required approval(s) on ${String(headSha ?? 'the head').slice(0, 7)}${approvers.length ? ` (${approvers.join(', ')})` : ''}${stale.length ? `; stale, from before the latest push: ${stale.join(', ')}` : ''}${blocking.length ? `; changes requested by ${blocking.join(', ')}` : ''}`;
  return { pass, required: required ?? 0, approvers, stale, blocking, summary };
}
