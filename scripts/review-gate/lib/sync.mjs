// The review gate's part of `board sync` (bookkeeping that belongs to no single run):
//   1. human reopens of triaged tickets (card moved back, issue reopened, "changes requested" reviews):
//      severity bump, `## Decisions` note for the re-run, `reopened` label, board event, metrics record,
//      and the PR's gate back to review when it is still open;
//   2. open gated PRs evaluated again (a PR waiting for its checks; see the gate's auto-merge);
//   3. closed gated PRs recorded for the retro (see pr-review.mjs).
// Everything is informational: a GitHub error is logged and the rest of the sync goes on.
import { appendJsonl, nowIso } from '../../pipeline/lib/util.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { extractDecisions, upsertDecisions } from '../../board/lib/escalation.mjs';
import { OUTCOMES_FILE } from '../../implement/lib/decisions.mjs';
import { setTriageFields } from './fields.mjs';
import { applyReview, decideGate, gateState, readPrState } from './gate.mjs';
import { addIssueLabel, checksState, disableAutoMerge, ghJson, issueAssignees, issueBody, prReviewComments, prReviews, prView, setIssueBody } from './github.mjs';
import { readCodeowners } from './publish.mjs';
import { cardReopen, newChangesRequested, reopenDecisionNote, withReopen } from './reopens.mjs';
import { prClass, prSeverity } from './severity.mjs';
import { extractTriage, upsertTriage } from './triage-section.mjs';
import { fieldValues } from './assessment.mjs';
import { requiredApprovals } from './quorum.mjs';

const safe = (fn, fallback, onError) => {
  try {
    return fn();
  } catch (error) {
    onError?.(error);
    return fallback;
  }
};

const nextRound = (body) => {
  const inner = extractDecisions(body) ?? '';
  const rounds = [...inner.matchAll(/^### Round (\d+)\b/gm)].map((m) => Number(m[1]));
  return rounds.length ? Math.max(...rounds) + 1 : 1;
};

// Records one human reopen of a triaged ticket. Returns the updated triage data, or null when the
// ticket has no triage (never assessed by the gate).
export function recordReopen(config, gh, { key, issue, reopen }, { metricsConfig, applyEvent = null, log = () => {} }) {
  const repo = config.board.repo;
  const body = issueBody(gh, repo, issue.number);
  const triage = extractTriage(body);
  if (!triage) return null;
  const next = withReopen(triage, reopen, config.implement.reviewGate);
  let updated = upsertTriage(body, next);
  updated = upsertDecisions(updated, { round: nextRound(updated), by: reopen.by ?? 'review-gate', at: reopen.at.slice(0, 10), answers: [], note: reopenDecisionNote(reopen) });
  setIssueBody(gh, repo, issue.number, updated);
  safe(() => setTriageFields(config, gh, issue, fieldValues(next)), null, (e) => log(`${key}: board fields not updated: ${e.message.split('\n')[0]}`));
  safe(() => addIssueLabel(gh, repo, issue.number, config.implement.reviewGate.labels?.reopened ?? 'reopened'), null, (e) => log(`${key}: label not added: ${e.message.split('\n')[0]}`));
  appendJsonl(metricsFile(metricsConfig, OUTCOMES_FILE), { ts: reopen.at, type: 'reopen', story: key, pr: reopen.pr ?? null, source: reopen.source, by: reopen.by ?? null, afterMerge: Boolean(reopen.afterMerge), reopens: next.reopens.length, severity: next.severity?.level ?? null, severityBase: next.severity?.base ?? null });
  if (applyEvent) {
    const n = next.reopens.length;
    const comment = `Human reopen #${n} (${reopen.detail ?? reopen.source}${reopen.pr ? `, ${reopen.pr}` : ''}). Severity is now **${next.severity?.level}** (${next.severity?.explanation}); this ticket can no longer auto-merge. ${reopen.afterMerge ? 'Its PR already merged, so `implement requeue` runs the fix again as a follow-up PR through the same gate.' : '`implement requeue` runs it again on its PR\'s branch.'} The reason is recorded under **Decisions** in the issue body for the re-run.`;
    safe(() => applyEvent(key, { type: 'reopened', id: `reopen:${key}:${n}`, body: comment }), null, (e) => log(`${key}: card not moved: ${e.message.split('\n')[0]}`));
  }
  log(`${key}: human reopen #${next.reopens.length} (${reopen.source}); severity ${next.severity?.level}.`);
  return next;
}

// An assessment rebuilt from what GitHub holds (the PR's gate state and each ticket's triage data), so
// any machine can evaluate a PR again without the original run.
export function rebuildAssessment(config, gh, pr, state, { log = () => {} } = {}) {
  const repo = config.board.repo;
  const view = prView(gh, repo, pr);
  const tickets = (state.tickets ?? []).map((t) => {
    const triage = t.issue ? safe(() => extractTriage(issueBody(gh, repo, t.issue)), null, (e) => log(`${t.key}: triage not read: ${e.message}`)) : null;
    return { key: t.key, issue: t.issue ? { number: t.issue } : null, ...(triage ?? {}), severity: triage?.severity ?? { level: t.severity ?? null }, confidence: triage?.confidence ?? { score: null, high: t.high, reasons: [] }, reopens: triage?.reopens ?? [], systems: triage?.systems ?? [], paths: triage?.paths ?? [] };
  });
  const systems = state.systems ?? { names: [], shared: false, contract: false };
  const severity = prSeverity({ tickets, systems }, config.implement.reviewGate);
  const ci = safe(() => checksState(gh, repo, pr), null);
  // CI is a live signal: refresh each ticket's CI criterion.
  for (const t of tickets) {
    if (!t.confidence?.criteria) continue;
    const ciState = ci === 'success' ? 'met' : ci === 'pending' ? 'pending' : ci == null ? 'unknown' : 'unmet';
    const others = (t.confidence.reasons ?? []).filter((r) => !/^CI /.test(r));
    t.confidence = { ...t.confidence, criteria: { ...t.confidence.criteria, ci: ciState }, reasons: ciState === 'met' ? others : [...others, `CI ${ciState}`] };
    t.confidence.high = ciState === 'met' && !others.length && (t.confidence.score ?? 0) >= (config.implement.reviewGate.confidence?.highMin ?? 85);
  }
  return { pr: view.url ?? pr, view, tickets, severity, systems, class: prClass({ severity: severity.level, shared: systems.shared || systems.contract }), ci, headSha: view.headRefOid ?? null, assessedAt: state.assessedAt ?? null, errors: [] };
}

// Evaluates an open gated PR again and applies the result (the notice, labels, reviewers). `onAutoMerge`
// handles a PR that now qualifies. Returns { decision, state }.
export function regate(config, gh, pr, { prior, cwd = config.root, log = () => {}, onAutoMerge = null, extraState = {} }) {
  const repo = config.board.repo;
  const a = rebuildAssessment(config, gh, pr, prior, { log });
  const decision = decideGate(a, { settings: config.implement.reviewGate, autoMerge: config.implement.autoMerge, prior });
  const state = { ...gateState(a, decision, prior), ...extraState };
  if (decision.action === 'auto-merge' && onAutoMerge) return onAutoMerge(a, decision, state);
  const effective = decision.action === 'auto-merge' ? { ...decision, action: 'review', approvals: 1, triggers: ['auto-merge is not available yet'], reasons: ['auto-merge is not available yet'] } : decision;
  const assignees = Object.fromEntries(a.tickets.map((t) => [t.key, t.issue ? safe(() => issueAssignees(gh, repo, t.issue.number), []) : []]));
  const applied = applyReview(config, gh, a, effective, { ...gateState(a, effective, prior), ...extraState }, { assignees, codeowners: readCodeowners(cwd), author: a.view.author, currentLabels: a.view.labels ?? [] });
  for (const p of applied.problems) log(`${pr}: ${p}`);
  return { decision: effective, state };
}

// Open PRs the gate has labeled (`approvals:N`, including approvals:0 for a PR waiting for its checks).
export function gatedPrs(config, gh, { state = 'open' } = {}) {
  const pattern = config.implement.reviewGate.labels?.approvals ?? 'approvals:{n}';
  const prs = ghJson(gh, ['pr', 'list', '-R', config.board.repo, '--state', state, '--limit', '200', '--json', 'number,url,state,labels,headRefName']) ?? [];
  return prs.filter((p) => requiredApprovals((p.labels ?? []).map((l) => l.name ?? l), pattern) != null);
}

// The board sync step. deps: { gh, items (board cards with severity, column, state, stateReason),
// markerOf(number) -> the last pipeline marker, commentsOf(number), applyEvent(key, event), metricsConfig,
// log, onAutoMerge }. Returns { reopens: [keys], regated: [pr urls] }.
export function syncGate(config, deps) {
  const { gh, items = [], log = () => {} } = deps;
  const at = deps.now ?? nowIso();
  const out = { reopens: [], regated: [] };
  const regate_ = new Set();

  // 1a. Cards and issues reopened by a person.
  for (const item of items.filter((i) => i.key && i.severity && !i.labels?.includes(config.board.epicLabel))) {
    const candidate = item.column === 'inProgress' || (item.state === 'OPEN' && item.column === 'done' && item.stateReason === 'REOPENED');
    if (!candidate) continue;
    const marker = safe(() => deps.markerOf(item.number), null, (e) => log(`${item.key}: comments not read: ${e.message}`));
    const found = cardReopen(item, marker);
    if (!found) continue;
    safe(
      () => {
        const triage = extractTriage(issueBody(gh, config.board.repo, item.number));
        if (!triage) return;
        const pr = triage.pr ? safe(() => prView(gh, config.board.repo, triage.pr), null) : null;
        const feedback = (deps.commentsOf?.(item.number) ?? []).filter((c) => !/<!-- pipeline-board:/.test(c.body ?? '') && (!marker?.at || String(c.createdAt ?? '') > marker.at)).map((c) => `${c.author ? `@${c.author}: ` : ''}${String(c.body ?? '').replace(/\s+/g, ' ').trim()}`).join(' / ');
        recordReopen(config, gh, { key: item.key, issue: { number: item.number, url: item.url }, reopen: { at, source: found.source, detail: found.detail, pr: triage.pr ?? null, afterMerge: pr?.state === 'MERGED', feedback: feedback || null } }, deps);
        out.reopens.push(item.key);
        if (pr?.state === 'OPEN') regate_.add(pr.url);
      },
      null,
      (e) => log(`${item.key}: reopen not recorded: ${e.message.split('\n')[0]}`),
    );
  }

  // 1b. "Changes requested" reviews on open gated PRs, and 2. every open gated PR evaluated again.
  const open = safe(() => gatedPrs(config, gh), [], (e) => log(`gated PRs not listed: ${e.message.split('\n')[0]}`));
  for (const p of open) {
    safe(
      () => {
        const prior = readPrState(gh, config.board.repo, p.url);
        if (!prior) return;
        const keys = (prior.tickets ?? []).map((t) => t.key);
        const fresh = newChangesRequested(prReviews(gh, config.board.repo, p.url), prReviewComments(gh, config.board.repo, p.url), keys, prior.countedReviews);
        const counted = [...(prior.countedReviews ?? [])];
        for (const cr of fresh) {
          for (const key of cr.keys) {
            const t = prior.tickets.find((x) => x.key === key);
            if (!t?.issue) continue;
            recordReopen(config, gh, { key, issue: { number: t.issue }, reopen: { at: cr.review.submitted_at ?? at, source: 'changes-requested', detail: `changes requested by @${cr.review.user?.login ?? '?'}`, by: cr.review.user?.login ?? null, pr: p.url, afterMerge: false, feedback: cr.feedback || null } }, deps);
            out.reopens.push(key);
          }
          counted.push(cr.review.id);
        }
        // A reopened ticket blocks the PR's auto-merge for good.
        if (fresh.length || regate_.has(p.url)) disableAutoMerge(gh, config.board.repo, p.url);
        if (fresh.length || regate_.has(p.url) || prior.action === 'wait') {
          regate(config, gh, p.url, { prior: { ...prior, countedReviews: counted }, cwd: deps.cwd ?? config.root, log, onAutoMerge: deps.onAutoMerge, extraState: { countedReviews: counted } });
          out.regated.push(p.url);
          regate_.delete(p.url);
        }
      },
      null,
      (e) => log(`${p.url}: not evaluated: ${e.message.split('\n')[0]}`),
    );
  }
  // A reopened ticket whose PR is open but no longer labeled (a person removed it) is gated again too.
  for (const url of regate_) {
    safe(
      () => {
        const prior = readPrState(gh, config.board.repo, url);
        if (!prior) return;
        disableAutoMerge(gh, config.board.repo, url);
        regate(config, gh, url, { prior, cwd: deps.cwd ?? config.root, log, onAutoMerge: deps.onAutoMerge });
        out.regated.push(url);
      },
      null,
      (e) => log(`${url}: not evaluated: ${e.message.split('\n')[0]}`),
    );
  }
  return out;
}
