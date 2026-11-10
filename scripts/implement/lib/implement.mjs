import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../../pipeline/lib/agents.mjs';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { escalate, clearEscalation, loadState, lockFile, metricsFile, updateState } from '../../pipeline/lib/state.mjs';
import { acquireLock, appendJsonl, extractResult, lockHolder, log, nowIso, readJsonl, releaseLock, run, tail } from '../../pipeline/lib/util.mjs';

const RUNS_FILE = 'implement-runs.jsonl';
const AGENT = 'implementer';

const git = (cwd, args) => run('git', args, { cwd });

// Environment for processes that must run the pipeline's own hooks: a run started from inside a
// pipeline agent would otherwise inherit PIPELINE_CHILD=1 and silence the review.
function hookEnv() {
  const env = { ...process.env };
  delete env.PIPELINE_CHILD;
  return env;
}

const pipelineCli = (dir) => path.join(dir, 'scripts', 'pipeline', 'pipeline.mjs');

function pipeline(dir, args, input = '') {
  return spawnSync(process.execPath, [pipelineCli(dir), ...args], { cwd: dir, input, encoding: 'utf8', env: hookEnv(), maxBuffer: 64 * 1024 * 1024 });
}

export const branchFor = (story) => `feat/${story.slug.toLowerCase()}`;
export const worktreeFor = (config, story) => path.join(config.root, config.implement.worktreeDir, story.key.toLowerCase());

// One worktree and branch per story, created from the base ref, so several stories can be
// implemented at once and each agent's hooks run against its own checkout.
export function prepareWorktree(config, story) {
  const dir = worktreeFor(config, story);
  const branch = branchFor(story);
  const [remote, ...rest] = config.baseRef.split('/');
  if (rest.length && git(config.root, ['remote']).stdout.split('\n').includes(remote)) {
    git(config.root, ['fetch', '--quiet', remote, rest.join('/')]);
  }
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, created: false };
  if (git(config.root, ['cat-file', '-e', `${config.baseRef}:${story.file}`]).status !== 0) {
    throw new Error(`${story.file} is not on ${config.baseRef}; merge the story before implementing it.`);
  }
  const exists = git(config.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  const args = exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, config.baseRef];
  const result = git(config.root, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return { dir, branch, created: true };
}

function initialTask(story, wt) {
  return [
    `Story: ${story.key}`,
    `Story file: ${story.file}`,
    '',
    `Implement ${story.key}. The AI pipeline started you, so section 1 of your instructions is partly done already:`,
    `- You are in the story's own worktree (${wt.dir}) on branch \`${wt.branch}\`, created from the base ref. Do not create, rename or reset branches.`,
    `- \`node scripts/pipeline/pipeline.mjs start ${story.key}\` has already run.`,
    '- Do everything else: graph setup, reading the story, implementing, the fast checks, closing out the story and committing.',
    `- Finish with \`node scripts/pipeline/pipeline.mjs done\`. The architecture review runs when you stop; if it requests changes, fix them and finish again.`,
    '',
    'End your final message with one line: `AGENT_RESULT: {"status": "done" | "blocked" | "needs-input", "summary": "...", "reason": "..."}`. Use "blocked" when a blocking story is not merged, and "needs-input" for an open question that changes the design.',
  ].join('\n');
}

function fixTask(story, reason) {
  return [
    `Story: ${story.key}`,
    `Story file: ${story.file}`,
    '',
    `You already implemented ${story.key} in this worktree and committed it. The architecture review requested changes:`,
    '',
    reason,
    '',
    'Fix every finding in the existing code (read the current diff first; do not start over), run the fast checks again, commit, and run `node scripts/pipeline/pipeline.mjs done`.',
    'End your final message with `AGENT_RESULT: {"status": "done" | "blocked" | "needs-input", "summary": "...", "reason": "..."}`.',
  ].join('\n');
}

// After the agent exits, run the same Stop dispatch its hooks run. If its CLI already ran the hooks
// (Claude Code, Copilot, Codex), this is a no-op; if not (custom commands, untrusted hooks), it makes
// the review and QE stages run anyway.
function dispatchStop(wtDir) {
  const result = pipeline(wtDir, ['hook', 'stop'], JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }));
  if (result.stderr.trim()) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    return { systemMessage: tail(result.stdout, 1000) };
  }
}

export function implementStory(config, story, { maxRuns = config.implement.maxRuns } = {}) {
  const lock = lockFile(config, story.key, 'implement');
  if (!acquireLock(lock)) throw new Error(`${story.key} is already being implemented (pid ${lockHolder(lock)}).`);
  const record = (patch) => updateState(config, story.key, (s) => Object.assign(s.implement, patch));
  try {
    const wt = prepareWorktree(config, story);
    const wtRel = path.relative(config.root, wt.dir);
    log(`${story.key}: ${wt.created ? 'created' : 'reusing'} worktree ${wtRel} on ${wt.branch}`);
    record({ status: 'running', worktree: wtRel, branch: wt.branch, pid: process.pid, startedAt: nowIso(), lastResult: null });
    clearEscalation(config, story, 'implement');

    const wtConfig = loadConfig('implement', wt.dir);
    const start = pipeline(wt.dir, ['start', story.key]);
    if (start.status !== 0) throw new Error(`pipeline start failed in ${wtRel}: ${start.stderr.trim()}`);

    let task = initialTask(story, wt);
    for (let runNo = 1; runNo <= maxRuns; runNo++) {
      log(`${story.key}: implementer run ${runNo}/${maxRuns}`);
      const agent = runAgent(wtConfig, {
        name: AGENT,
        mode: 'implement',
        cwd: wt.dir,
        model: config.agent.models.implementer ?? null,
        timeoutSec: config.implement.timeoutSec,
        extraEnv: { PIPELINE_CHILD: '' },
        task,
      });
      const result = extractResult(agent.output);
      appendJsonl(metricsFile(wtConfig, RUNS_FILE), {
        ts: nowIso(), story: story.key, run: runNo, ok: agent.ok, timedOut: agent.timedOut, seconds: agent.seconds,
        status: result?.status ?? null, prompt_version: agent.version, cli: config.agent.cmd ? 'custom' : config.agent.cli,
      });

      if (result?.status === 'blocked' || result?.status === 'needs-input') {
        const reason = result.reason || result.summary || 'no reason given';
        escalate(config, story, 'implement', result.status === 'blocked' ? 'implementation blocked' : 'implementation needs a decision', reason);
        return record({ status: result.status, runs: runNo, pid: null, finishedAt: nowIso(), lastResult: reason });
      }
      if (!agent.ok && !result) {
        task = fixTask(story, `The previous run ${agent.timedOut ? 'timed out' : `failed (exit ${agent.status})`} before finishing. Check the worktree state and finish the story.`);
        continue;
      }

      if (!loadState(wtConfig, story.key).done) pipeline(wt.dir, ['done', story.key]);
      const stop = dispatchStop(wt.dir);
      if (stop.decision === 'block') {
        task = fixTask(story, stop.reason);
        continue;
      }
      const { review } = loadState(wtConfig, story.key);
      const status = review.lastVerdict === 'APPROVED' ? 'approved' : review.lastVerdict === 'ESCALATED' ? 'escalated' : 'stopped';
      return record({ status, runs: runNo, pid: null, finishedAt: nowIso(), lastResult: stop.systemMessage ?? result?.summary ?? null });
    }
    escalate(config, story, 'implement', `not approved after ${maxRuns} implementer runs`, 'See the review findings in the worktree: `node scripts/review/review.mjs status ' + story.key + '`.');
    return record({ status: 'escalated', runs: maxRuns, pid: null, finishedAt: nowIso() });
  } catch (error) {
    record({ status: 'failed', pid: null, finishedAt: nowIso(), lastResult: error.message });
    throw error;
  } finally {
    releaseLock(lock);
  }
}

export function startInBackground(config, story) {
  const lock = lockFile(config, story.key, 'implement');
  if (lockHolder(lock)) throw new Error(`${story.key} is already being implemented (pid ${lockHolder(lock)}).`);
  const bg = spawnBackground(config, { script: path.join(config.root, 'scripts', 'implement', 'implement.mjs'), key: story.key, stage: 'implement', args: ['run', story.key] });
  updateState(config, story.key, (s) => Object.assign(s.implement, { status: 'starting', pid: bg.pid, log: bg.log }));
  return bg;
}

// Review and QE state live in the story's worktree, so status reads them from there.
export function statusLine(config, story) {
  const { implement } = loadState(config, story.key);
  let line = `${story.key.padEnd(10)} implement=${implement.status}${implement.runs ? ` (runs ${implement.runs})` : ''}`;
  if (implement.worktree && fs.existsSync(path.join(config.root, implement.worktree))) {
    const wt = loadState(loadConfig('implement', path.join(config.root, implement.worktree)), story.key);
    line += ` worktree=${implement.worktree} review=${wt.review.lastVerdict ?? '-'} automation=${wt.automation.status}`;
  }
  return line;
}

export function implementMetrics(config, { since } = {}) {
  const runs = readJsonl(metricsFile(config, RUNS_FILE)).filter((r) => !since || r.ts >= since);
  const stories = new Set(runs.map((r) => r.story));
  const firstTry = [...stories].filter((key) => runs.filter((r) => r.story === key).length === 1).length;
  return {
    runs: runs.length,
    stories: stories.size,
    blocked: runs.filter((r) => r.status === 'blocked' || r.status === 'needs-input').length,
    failed: runs.filter((r) => !r.ok).length,
    singleRunRate: stories.size ? Math.round((firstTry / stories.size) * 100) / 100 : 0,
  };
}
