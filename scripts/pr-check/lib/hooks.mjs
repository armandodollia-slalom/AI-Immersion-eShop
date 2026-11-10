// PR check as the last Stop-hook stage: once the architecture review has approved the implementation
// and QE has verified its tests, a report-only PR check runs in the background. Its findings go back
// to the agent on its next stop (or at the next session start); the agent is the fixer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { implChanges } from '../../pipeline/lib/git.mjs';
import { clearEscalation, escalate, lockFile, loadState, logFile, updateState } from '../../pipeline/lib/state.mjs';
import { isPidAlive, lockHolder, log, nowIso, sleep } from '../../pipeline/lib/util.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pr-check.mjs');
const block = (reason) => ({ decision: 'block', reason });
const notice = (message) => ({ systemMessage: message });
const settings = (config) => ({ enabled: true, requireTests: true, waitForTestsMin: 180, pollSec: 20, maxRuns: 3, codeAgents: ['implementer'], ...config.prCheck.hook });

export const hookSkipped = (config) => process.env.PR_CHECK_SKIP === '1' || !settings(config).enabled;

// Main-session stops always count; subagent stops only for the agents that write the code.
function isCodeAgentStop(config, payload) {
  if (payload.hook_event_name !== 'SubagentStop' || !payload.agent_type) return true;
  return settings(config).codeAgents.includes(payload.agent_type);
}

const formatFindings = (findings) => findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.id} (${f.lens}) ${f.title}`).join('\n');

export function resetPrCheck(config, story) {
  updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'idle', hash: null, pid: null, log: null, verdict: null, score: null, openFindings: [], report: null, reason: null, deliveries: 0, runs: 0 }));
}

// Hands a finished result to the agent: a failing check blocks with its findings, then once more if
// nothing changed, then says so once; a pass is one notice.
function deliver(config, story, pc, payload) {
  const bump = () => updateState(config, story.key, (s) => (s.prCheck.deliveries += 1));
  if (pc.verdict === 'PASS') {
    if (pc.deliveries > 0) return null;
    bump();
    return notice(`PR check: ${story.key} scored ${pc.score}/10 against its story (acceptance criteria, flow, design, style, video). Report: ${pc.report}`);
  }
  if (pc.deliveries === 0) {
    bump();
    return block(`The PR check of ${story.key} scored ${pc.score}/10 against its story. ${pc.reason ?? ''}\n\nOpen findings (details and fixes in ${pc.report}):\n${formatFindings(pc.openFindings)}\n\nFix them, then finish your turn; the check runs again after the architecture review and QE pass.`);
  }
  if (pc.deliveries === 1 && !payload.stop_hook_active) {
    bump();
    return block(`The PR check findings for ${story.key} are still open and nothing has changed since the check. Address them (see ${pc.report}):\n${formatFindings(pc.openFindings)}`);
  }
  if (pc.deliveries <= 2) {
    updateState(config, story.key, (s) => (s.prCheck.deliveries = 3));
    return notice(`PR check: ${story.key} still has ${pc.openFindings.length} open finding(s) and the code has not changed. Run \`node scripts/pr-check/pr-check.mjs status ${story.key}\` for details.`);
  }
  return null;
}

// Stop hook, after review and qe in the dispatcher. Its gate is the review's approval of the code on
// disk; the check itself waits in the background for QE to verify the tests, so the agent can finish.
export function hookStop(config, story, payload = {}) {
  if (hookSkipped(config) || !isCodeAgentStop(config, payload)) return null;
  const state = loadState(config, story.key);
  if (!state.done) return null;
  const { hash } = implChanges(config);
  if (!hash || state.review.lastVerdict !== 'APPROVED' || state.review.approvedHash !== hash) return null;
  const pc = state.prCheck;

  if (pc.hash === hash) {
    if (pc.status === 'done') return deliver(config, story, pc, payload);
    if (['waiting', 'running'].includes(pc.status) && (!pc.pid || isPidAlive(pc.pid))) return null;
    if (['skipped', 'error', 'escalated'].includes(pc.status)) return null;
  }

  const { maxRuns } = settings(config);
  if (pc.runs >= maxRuns && pc.verdict === 'FAIL') {
    updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'escalated', hash }));
    escalate(config, story, 'pr-check', `still failing after ${pc.runs} PR checks`, `Last score ${pc.score}/10. Open findings:\n${formatFindings(pc.openFindings)}\n\nReport: ${pc.report}`);
    return notice(`PR check: ${story.key} still failed after ${pc.runs} checks. A human needs to decide; see .agent-state/escalations/${story.key}-pr-check.md.`);
  }

  // Saved before spawning: the waiter checks that its hash is still the current one.
  const file = logFile(config, story.key, 'pr-check');
  const rel = path.relative(config.root, file);
  updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'waiting', hash, pid: null, log: rel, reason: null, deliveries: 0 }));
  const bg = spawnBackground(config, { script: SCRIPT, key: story.key, stage: 'pr-check', args: ['hook-run', story.key, '--hash', hash], file });
  updateState(config, story.key, (s) => {
    if (s.prCheck.hash === hash && !s.prCheck.pid) s.prCheck.pid = bg.pid;
  });
  return notice(`PR check: ${story.key} will be checked against its story in the background once QE has verified the tests (log: ${bg.log}). Findings come back on your next stop.`);
}

// What keeps the waiter waiting: QE automation is (or is about to be) working on this implementation.
function testsPending(config, story, automation, hash) {
  return ['starting', 'running'].includes(automation.status) || automation.requestedHash === hash || Boolean(lockHolder(lockFile(config, story.key, 'automation')));
}

// The background half of the hook: wait for QE, run one report-only check, record the result.
export async function hookRun(config, story, hash, executeCheck) {
  const { requireTests, waitForTestsMin, pollSec } = settings(config);
  const deadline = Date.now() + waitForTestsMin * 60_000;
  const set = (fields) => updateState(config, story.key, (s) => Object.assign(s.prCheck, fields));
  const current = () => loadState(config, story.key).prCheck.hash === hash;

  if (!current()) return 0;
  set({ pid: process.pid });
  for (;;) {
    if (!current()) {
      log(`superseded: ${story.key} has a newer PR check`);
      return 0;
    }
    if (implChanges(config).hash !== hash) {
      set({ status: 'stale', reason: 'the implementation changed while waiting' });
      return 0;
    }
    const { automation } = loadState(config, story.key);
    if (!requireTests || automation.verifiedHash === hash) break;
    if (!testsPending(config, story, automation, hash)) {
      set({ status: 'skipped', reason: `QE test automation ended "${automation.status}" without verifying this implementation` });
      log(`skipped: automation ${automation.status}`);
      return 0;
    }
    if (Date.now() > deadline) {
      set({ status: 'skipped', reason: `QE did not verify the tests within ${waitForTestsMin} minutes` });
      log('skipped: timed out waiting for QE');
      return 0;
    }
    await sleep(pollSec * 1000);
  }

  set({ status: 'running', startedAt: nowIso() });
  let summary;
  try {
    summary = await executeCheck(config, { story: story.key, 'no-fix': true });
  } catch (error) {
    if (current()) set({ status: 'error', reason: error.message });
    log(`PR check failed: ${error.message}`);
    return 1;
  }
  if (!current()) return 0;
  if (implChanges(config).hash !== hash) {
    set({ status: 'stale', reason: 'the implementation changed during the check' });
    return 0;
  }
  const pass = summary.verdict === 'PASS';
  updateState(config, story.key, (s) =>
    Object.assign(s.prCheck, {
      status: 'done',
      verdict: summary.verdict,
      score: summary.score,
      openFindings: summary.openFindings,
      report: summary.report,
      reason: summary.reason,
      deliveries: 0,
      runs: pass ? 0 : s.prCheck.runs + 1,
      finishedAt: nowIso(),
    }),
  );
  if (pass) clearEscalation(config, story, 'pr-check');
  log(`${story.key}: ${summary.verdict} ${summary.score}/10`);
  return 0;
}

export function sessionContext(config, story) {
  if (!story || hookSkipped(config)) return '';
  const pc = loadState(config, story.key).prCheck;
  if (pc.status !== 'done') return `PR check for ${story.key}: ${pc.status === 'idle' ? 'not run' : pc.status}${pc.reason ? ` (${pc.reason})` : ''}.`;
  const line = `PR check for ${story.key}: ${pc.verdict} ${pc.score}/10 (report: ${pc.report}).`;
  return pc.verdict === 'PASS' ? line : `${line}\nOpen findings to fix:\n${formatFindings(pc.openFindings)}`;
}
