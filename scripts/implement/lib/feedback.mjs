// The story-level feedback loop's nits-and-scope rule (the pair loop's is in orchestrate.mjs, with the
// same JSON shape and lib/disputes.mjs): findings from the architecture review and bugs from QE go to the
// orchestrator with ids; it may dispute nits and scope creep instead of acting on them
// (`disputes: [{finding, kind: "nit" | "out-of-scope", reason}]`) and list real problems outside the
// ticket as `followUps: [{title, reason}]`. Review disputes go to the next reviewer round, which accepts or
// re-asserts them with evidence (scripts/review/lib/review.mjs applyReviewDisputes); a finding re-asserted
// twice stays blocking. QE bugs are failing tests, so their disputes are recorded for the retro only.
// See docs/ai-pipeline/implement.md#nits-and-scope.
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { writeJson } from '../../pipeline/lib/util.mjs';
import { readReviewDisputes, reviewDisputesFile } from '../../review/lib/review.mjs';
import { openDisputes, parseImplementerReport, withIds } from './disputes.mjs';

const SOURCE_ID = { 'architecture-reviewer': 'review', 'qe-automation': 'qe' };

export const DISPUTE_INSTRUCTIONS = 'You do not have to act on a nit (a style, naming or preference finding that does not affect the acceptance criteria, correctness, security or the mockup) or on a request that widens the ticket\'s scope. Dispute it instead in your AGENT_RESULT: `"disputes": [{"finding": "<id>", "kind": "nit" | "out-of-scope", "reason": "<the acceptance criterion, owns or mockup that shows why>"}]`, and list real problems outside this ticket as `"followUps": [{"title": "...", "reason": "..."}]`. The reviewer rules on each dispute; a finding it re-asserts with evidence twice stays blocking.';

export function newFeedbackLog() {
  let current = null;
  const disputes = [];
  const followUps = [];
  return {
    disputes,
    followUps,
    // The findings handed to the orchestrator, with ids; returns the text added to its feedback.
    // A review finding raised again keeps the id it had when it was disputed (matched by its text), so
    // its dispute and re-assert counts carry over and the pair cannot ping-pong.
    given(source, findings, { round, config = null, key = null }) {
      const known = source === 'architecture-reviewer' && config ? Object.entries(readReviewDisputes(config, key).state) : [];
      const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const list = withIds(findings, { subtask: SOURCE_ID[source] ?? source, round }).map((f) => {
        const hit = known.find(([, st]) => st.issue && norm(st.issue) === norm(f.issue));
        return hit ? { ...f, id: hit[0] } : f;
      });
      current = { source, findings: list };
      if (!list.length) return '';
      return `\n\nFinding ids (use them in disputes):\n${list.map((f) => `- ${f.id}: ${String(f.issue ?? f.title ?? '').slice(0, 300)}`).join('\n')}\n\n${DISPUTE_INSTRUCTIONS}`;
    },
    // After an orchestrator run: its disputes and follow-ups are recorded, and review disputes are handed
    // to the next review round.
    afterRun(config, key, reported, { round }) {
      const report = parseImplementerReport(reported, current?.findings ?? []);
      const source = current?.source ?? null;
      current = null;
      followUps.push(...report.followUps.map((u) => ({ ...u, source })));
      if (!report.disputes.length && !report.followUps.length) return report;
      disputes.push(...report.disputes.map((d) => ({ ...d, source })));
      if (source === 'architecture-reviewer' && report.disputes.length) {
        const d = readReviewDisputes(config, key);
        const state = new Map(Object.entries(d.state));
        const { open, overruled } = openDisputes(report.disputes, state);
        for (const x of report.disputes) state.set(x.id, { ...state.get(x.id), issue: x.issue });
        writeJson(reviewDisputesFile(config, key), { ...d, open, overruled, state: Object.fromEntries(state) });
      }
      logDecision(config, {
        stage: 'implement',
        story: key,
        round,
        agent: 'implementer',
        subject: source ?? 'implementer',
        decision: report.disputes.length ? 'disputed' : 'follow-ups',
        reason: null,
        followUps: report.followUps,
        items: report.disputes.map((x) => ({ finding: x.id, kind: x.kind, issue: x.issue, reason: x.reason })),
      });
      return report;
    },
    counts: () => ({ nit: disputes.filter((d) => d.kind === 'nit').length, outOfScope: disputes.filter((d) => d.kind === 'out-of-scope').length, total: disputes.length }),
  };
}
