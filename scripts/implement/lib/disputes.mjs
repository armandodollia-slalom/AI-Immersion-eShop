// Disputes between a pair implementer and its verifier. The implementer does not have to act on nits
// (findings that do not touch the ticket's acceptance criteria, correctness, security or the mockup) or on
// requests that widen the ticket's scope: it disputes them in its result instead, and moves real problems
// outside the ticket to follow-ups. The next verifier round accepts each dispute (drops the finding) or
// re-asserts the finding with evidence that the ticket requires it. A disputed finding raised again without
// evidence does not block; one re-asserted twice stays blocking and can no longer be disputed, so the pair
// cannot ping-pong. Pure functions; the pair loop in orchestrate.mjs keeps the state. See
// docs/ai-pipeline/implement.md#nits-and-scope.

export const DISPUTE_KINDS = ['nit', 'out-of-scope'];
export const MAX_REASSERTS = 2;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const norm = (s) => str(s).toLowerCase().replace(/\s+/g, ' ');

// Gives every finding without one a stable id (`<subtask>-r<round>-<n>`); a verifier that re-raises a
// finding keeps its id.
export function withIds(findings, { subtask, round }) {
  return (findings ?? []).map((f, i) => (str(f.id) ? f : { ...f, id: `${subtask}-r${round}-${i + 1}` }));
}

// The implementer's disputes and follow-ups from its AGENT_RESULT, matched to the findings it was given
// (by id, else by the quoted issue). Unknown findings and kinds are dropped.
export function parseImplementerReport(reported, findings) {
  const disputes = [];
  for (const d of Array.isArray(reported?.disputes) ? reported.disputes : []) {
    const ref = str(d?.finding);
    const kind = DISPUTE_KINDS.includes(d?.kind) ? d.kind : null;
    if (!ref || !kind) continue;
    const f = findings.find((x) => x.id === ref) ?? findings.find((x) => norm(x.issue) && (norm(ref).includes(norm(x.issue)) || norm(x.issue).includes(norm(ref))));
    if (f && !disputes.some((x) => x.id === f.id)) disputes.push({ id: f.id, issue: f.issue ?? '', kind, reason: str(d.reason) });
  }
  const followUps = (Array.isArray(reported?.followUps) ? reported.followUps : []).filter((u) => str(u?.title)).map((u) => ({ title: str(u.title), reason: str(u.reason) }));
  return { disputes, followUps };
}

// Splits the implementer's disputes into the ones the next verifier rules on and the ones overruled
// because the verifier already re-asserted the finding MAX_REASSERTS times. Updates `state` (id -> counts).
export function openDisputes(disputes, state) {
  const open = [];
  const overruled = [];
  for (const d of disputes) {
    const s = state.get(d.id) ?? { disputes: 0, reasserts: 0 };
    if (s.reasserts >= MAX_REASSERTS) overruled.push({ ...d, ruling: 'overruled' });
    else {
      s.disputes++;
      open.push(d);
    }
    state.set(d.id, s);
  }
  return { open, overruled };
}

// Applies the verifier's rulings to its verdict. A disputed finding it raised again counts as re-asserted
// only with evidence (the finding's `evidence`, or the ruling's); without, it is accepted and demoted to
// minor. A dispute the verifier explicitly accepted drops the finding to minor too. Returns the verdict
// with the verdict recomputed from the blocking findings, and the rulings.
export function ruleDisputes(verdict, open, state, overruled = []) {
  const explicit = new Map((Array.isArray(verdict.disputes) ? verdict.disputes : []).filter((r) => str(r?.finding)).map((r) => [str(r.finding), r]));
  const rulings = [];
  const findings = [...verdict.findings];
  for (const d of open) {
    const idx = findings.findIndex((f) => f.id === d.id || (norm(f.issue) && norm(f.issue) === norm(d.issue)));
    const said = explicit.get(d.id);
    const f = idx >= 0 ? findings[idx] : null;
    const evidence = str(f?.evidence) || str(said?.evidence);
    const reasserted = f && f.severity !== 'minor' && said?.decision !== 'accepted' && Boolean(evidence);
    if (reasserted) {
      const s = state.get(d.id);
      s.reasserts++;
      findings[idx] = { ...f, id: d.id, reasserted: s.reasserts, evidence };
    } else if (f && f.severity !== 'minor') {
      findings[idx] = { ...f, id: d.id, severity: 'minor', disputeAccepted: true };
    }
    rulings.push({ ...d, ruling: reasserted ? 'reasserted' : 'accepted', evidence: reasserted ? evidence : str(said?.evidence) || null });
  }
  // A finding re-asserted MAX_REASSERTS times is not ruled on again: the implementer's new dispute of it is
  // overruled, and the finding stands as the verifier raises it.
  for (const d of overruled) rulings.push({ ...d, ruling: 'overruled' });
  const blocking = findings.filter((f) => f.severity !== 'minor');
  return { verdict: { ...verdict, findings, verdict: blocking.length ? 'CHANGES_REQUESTED' : 'APPROVED' }, rulings };
}

// Counts for the round record.
export const disputeCounts = (rulings, followUps) => ({
  nit: rulings.filter((r) => r.kind === 'nit').length,
  outOfScope: rulings.filter((r) => r.kind === 'out-of-scope').length,
  accepted: rulings.filter((r) => r.ruling === 'accepted').length,
  reasserted: rulings.filter((r) => r.ruling === 'reasserted').length,
  overruled: rulings.filter((r) => r.ruling === 'overruled').length,
  followUps: followUps.length,
});

// The disputes block of a verifier's task.
export function formatDisputes(open, overruled = []) {
  if (!open.length && !overruled.length) return '';
  const lines = open.map((d) => `- ${d.id} (${d.kind}): "${d.issue}"\n  Implementer: ${d.reason || '(no reason given)'}`);
  for (const d of overruled) lines.push(`- ${d.id}: "${d.issue}" was re-asserted ${MAX_REASSERTS} times; the implementer's new dispute is overruled and it stays blocking until fixed.`);
  return lines.join('\n');
}
