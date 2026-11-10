// PR check as the last Stop-hook stage: once the architecture review has approved the implementation
// and QE has verified its tests, a report-only PR check runs in the background. Its findings go back
// to the agent on its next stop (or at the next session start); the agent is the fixer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { implChanges } from '../../pipeline/lib/git.mjs';
import { nextAttempt, runDied } from '../../pipeline/lib/recovery.mjs';
import { clearEscalation, escalate, lockFile, loadState, logFile, updateState } from '../../pipeline/lib/state.mjs';
import { listStories, resolveStory } from '../../pipeline/lib/stories.mjs';
import { bootId, lockHolder, log, nowIso, selfProcess, sleep } from '../../pipeline/lib/util.mjs';

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
  updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'idle', hash: null, pid: null, log: null, verdict: null, score: null, openFindings: [], report: null, reason: null, deliveries: 0, runs: 0, recoveries: 0, retryAt: null }));
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
    if (['waiting', 'running'].includes(pc.status)) {
      const recovered = recoverHookRun(config, story);
      return recovered ? notice(`PR check: ${recovered}`) : null;
    }
    if (['skipped', 'error', 'escalated', 'crashed'].includes(pc.status)) return null;
  }

  const { maxRuns } = settings(config);
  if (pc.runs >= maxRuns && pc.verdict === 'FAIL') {
    updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'escalated', hash }));
    escalate(config, story, 'pr-check', `still failing after ${pc.runs} PR checks`, `Last score ${pc.score}/10. Open findings:\n${formatFindings(pc.openFindings)}\n\nReport: ${pc.report}`);
    return notice(`PR check: ${story.key} still failed after ${pc.runs} checks. A human needs to decide; see .agent-state/escalations/${story.key}-pr-check.md.`);
  }

  const bg = spawnWaiter(config, story, hash, { recoveries: 0, retryAt: null });
  return notice(`PR check: ${story.key} will be checked against its story in the background once QE has verified the tests (log: ${bg.log}). Findings come back on your next stop.`);
}

// Saved before spawning: the waiter checks that its hash is still the current one.
function spawnWaiter(config, story, hash, fields) {
  const file = logFile(config, story.key, 'pr-check');
  const rel = path.relative(config.root, file);
  updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'waiting', hash, pid: null, boot: null, log: rel, reason: null, deliveries: 0, requestedAt: nowIso(), ...fields }));
  const bg = spawnBackground(config, { script: SCRIPT, key: story.key, stage: 'pr-check', args: ['hook-run', story.key, '--hash', hash], file });
  updateState(config, story.key, (s) => {
    if (s.prCheck.hash === hash && !s.prCheck.pid) Object.assign(s.prCheck, { pid: bg.pid, boot: bootId() });
  });
  return bg;
}

// A background check whose process died (crash, kill, reboot) while waiting or checking starts over,
// at most recovery.maxAttempts times with growing delays, then escalates. Returns what happened, or
// null when the check is not interrupted.
export function recoverHookRun(config, story, { force = false } = {}) {
  const pc = loadState(config, story.key).prCheck;
  if (!runDied(config, pc, { active: ['waiting', 'running'] })) return null;
  if (implChanges(config).hash !== pc.hash) {
    updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'stale', pid: null, reason: 'interrupted, and the implementation has changed since' }));
    return `the interrupted PR check of ${story.key} is out of date; it runs again after the next review and QE pass.`;
  }
  const next = nextAttempt(config, pc, { force });
  if (next.action === 'waiting') return null;
  if (next.action === 'crashed') {
    updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'crashed', pid: null, reason: `the background check died ${next.attempts} times` }));
    escalate(config, story, 'pr-check', `background PR check crashed ${next.attempts} times`, `Run \`node scripts/pr-check/pr-check.mjs resume ${story.key} --force\` to try again.`);
    return `the background PR check of ${story.key} died ${next.attempts} times; escalated (see .agent-state/escalations/${story.key}-pr-check.md).`;
  }
  const bg = spawnWaiter(config, story, pc.hash, next.fields);
  log(`${story.key}: restarted the interrupted PR check (attempt ${next.attempt}/${next.maxAttempts})`);
  return `restarted the interrupted PR check of ${story.key} (attempt ${next.attempt}/${next.maxAttempts}, log: ${bg.log}).`;
}

// `resume`: every story's interrupted background check (or one story's); --force also retries crashed ones.
export function recoverHookRuns(config, { key = null, force = false } = {}) {
  if (hookSkipped(config)) return [];
  const stories = key ? [resolveStory(config, key)].filter(Boolean) : listStories(config);
  return stories
    .map((story) => {
      if (force && loadState(config, story.key).prCheck.status === 'crashed') {
        updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'running', pid: null, requestedAt: null, recoveries: 0, retryAt: null }));
      }
      const line = recoverHookRun(config, story, { force });
      return line && `${story.key}: ${line}`;
    })
    .filter(Boolean);
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
  set(selfProcess());
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
    summary = await executeCheck(config, { story: story.key, 'no-fix': true, hook: true });
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
  const recovered = recoverHookRun(config, story);
  const pc = loadState(config, story.key).prCheck;
  if (recovered) return `PR check: ${recovered}`;
  if (pc.status !== 'done') return `PR check for ${story.key}: ${pc.status === 'idle' ? 'not run' : pc.status}${pc.reason ? ` (${pc.reason})` : ''}.`;
  const line = `PR check for ${story.key}: ${pc.verdict} ${pc.score}/10 (report: ${pc.report}).`;
  return pc.verdict === 'PASS' ? line : `${line}\nOpen findings to fix:\n${formatFindings(pc.openFindings)}`;
}
