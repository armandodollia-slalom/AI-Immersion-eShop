#!/usr/bin/env node
// PR check: an adversarial review loop that scores a pull request against its story (acceptance
// criteria, flow, UI design, code style, video evidence) and fixes it until it scores 10/10.
// See docs/ai-pipeline/pr-check.md.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readPayload, requireStory, runMain } from '../pipeline/lib/cli.mjs';
import { isDisabled, loadConfig } from '../pipeline/lib/config.mjs';
import { git } from '../pipeline/lib/git.mjs';
import { lockFile, metricsFile } from '../pipeline/lib/state.mjs';
import { activeStory } from '../pipeline/lib/stories.mjs';
import { acquireLock, log, lockHolder, nowIso, readJson, readJsonl, releaseLock, selfProcess, setLogTag, writeJson } from '../pipeline/lib/util.mjs';
import { renderMockups } from '../implement/lib/mockups.mjs';
import { isClean, removeCheckout, resolveTarget } from './lib/context.mjs';
import { commentOnPullRequest } from './lib/github.mjs';
import { hookRun, hookStop, recoverHookRuns, resetPrCheck, sessionContext } from './lib/hooks.mjs';
import { CHECKS_FILE, LENSES, runPrCheck } from './lib/loop.mjs';
import { renderReport } from './lib/report.mjs';
import { interruptedRuns, readProgress, resumeRuns, writeProgress } from './lib/runs.mjs';
import { extractVideoFrames, videoSources } from './lib/video.mjs';

setLogTag('pr-check');

const USAGE = `Usage: node scripts/pr-check/pr-check.mjs <command> [options]

  run [--pr <n>] [--story <KEY>] [--stories <KEY>,...] [--epic <EPIC>] [--lenses <lens>,...]
      [--base <ref>] [--videos <path|url>,...]
      [--no-fix] [--max-rounds <n>] [--debate-turns <n>] [--comment] [--push] [--json]
        Review the PR (or the current branch) against its story until it scores 10/10.
        Without --pr it checks the current branch. --no-fix runs one report-only round.
        --stories / --epic hold it to several tickets (an epic's stories, and the epic's journey);
        --lenses runs only those lenses (acceptance, flow, design, style, video).
        --resume continues an interrupted run of the same check from its last saved round.
  resume [KEY|pr-<n>] [--force] restart interrupted checks in the background (manual runs from their
                                last round, Stop-hook runs from the start), at most recovery.maxAttempts times
  status [pr-<n>|KEY]           last result of each check (or one)
  metrics [--json] [--since <iso-date>]

Hooks (called by scripts/pipeline/pipeline.mjs; PR_CHECK_SKIP=1 turns them off)
  hook stop | hook session-start | hook story-start <story>
  hook-run <story> --hash <impl-hash>   background half of the Stop hook: waits for QE, then checks

Models: PR_CHECK_MODEL_<ROLE> (JUDGE, ACCEPTANCE, FLOW, DESIGN, STYLE, VIDEO, DEFENDER, FIXER)
overrides scripts/pr-check/config.json.`;

const VALUE_FLAGS = new Set(['pr', 'story', 'stories', 'epic', 'lenses', 'base', 'videos', 'max-rounds', 'debate-turns', 'since', 'hash']);
const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

const resultDir = (config, id) => path.join(config.root, config.stateDir, 'pr-check', id);

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

// One check; returns the summary saved to .agent-state/pr-check/<id>/result.json.
async function executeCheck(config, flags) {
  const fix = !flags['no-fix'];
  if (flags['max-rounds']) config.prCheck.maxRounds = positiveInt(flags['max-rounds'], 'max-rounds');
  if (flags['debate-turns']) config.prCheck.debateTurns = Number(flags['debate-turns']);
  if (!fix) config.prCheck.maxRounds = 1;

  const only = list(flags.lenses);
  const unknown = only.filter((l) => !LENSES[l]);
  if (unknown.length) throw new Error(`unknown lens ${unknown.join(', ')} (lenses: ${Object.keys(LENSES).join(', ')})`);
  const ctx = await resolveTarget(config, { pr: flags.pr ? positiveInt(flags.pr, 'pr') : null, story: flags.story, stories: list(flags.stories).map((k) => k.toUpperCase()), epic: typeof flags.epic === 'string' ? flags.epic : null, base: flags.base, fix });
  ctx.only = only;
  const lock = lockFile(config, ctx.id, 'pr-check');
  if (!acquireLock(lock)) throw new Error(`a PR check of ${ctx.id} is already running (pid ${lockHolder(lock)})`);
  // Manual runs record their progress so an interrupted one can resume; Stop-hook runs recover through prCheck state.
  const manual = !flags.hook;
  const saved = flags.resume ? readProgress(config, ctx.id) : null;
  const resume = fix && saved?.branch === ctx.branch ? saved.loop ?? null : null;
  try {
    if (flags.resume && !saved) throw new Error(`there is no interrupted PR check of ${ctx.id} to resume`);
    if (resume) log(`resuming ${ctx.id} at round ${resume.round} (${resume.phase})`);
    // The fixer's changes are committed with `git add -A`; refuse to sweep someone's uncommitted work in.
    // A fix cut short leaves its changes behind; the resumed fix picks them up.
    if (fix && resume?.phase !== 'fix' && !isClean(config, ctx)) throw new Error('the working tree has uncommitted changes; commit or stash them, or pass --no-fix');
    ctx.runDir = path.join(ctx.workRoot, config.stateDir, 'pr-check', ctx.id);
    if (!resume) fs.rmSync(ctx.runDir, { recursive: true, force: true });
    if (manual) {
      const keep = { recoveries: saved?.recoveries ?? 0, retryAt: saved?.retryAt ?? null, loop: resume };
      writeProgress(config, ctx.id, { story: ctx.story.key, branch: ctx.branch, flags: { ...flags, resume: undefined }, ...keep, ...selfProcess(), startedAt: nowIso(), finishedAt: null, error: null });
    }
    const contextDir = path.join(ctx.runDir, 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'pr.md'), ctx.pr ? `# #${ctx.pr.number} ${ctx.pr.title}\n\n${ctx.pr.url}\n\n${ctx.pr.body || '(no description)'}\n` : `No pull request: checking branch ${ctx.branch}.\n`);

    const values = typeof flags.videos === 'string' ? flags.videos.split(',').map((v) => v.trim()).filter(Boolean) : [];
    ctx.video = await extractVideoFrames(config, ctx.runDir, videoSources(config, { values, prBody: ctx.pr?.body ?? '' }), ctx.workRoot);
    writeJson(path.join(contextDir, 'frames.json'), ctx.video);
    // The design lens gets PNG renders of every mockup screen and state (cached by the mockups' sha).
    if (ctx.isFrontend && ctx.mockups.length && (!ctx.only?.length || ctx.only.includes('design'))) {
      ctx.mockupRenders = await renderMockups({ files: ctx.mockups, outDir: path.join(contextDir, 'mockups'), cacheDir: path.join(config.root, config.stateDir, 'pr-check', '.mockup-cache') });
      if (!ctx.mockupRenders.ok) log(`could not render the mockups (${ctx.mockupRenders.error}); the design critic reads the sources`);
    }

    log(`checking ${ctx.id} against ${ctx.story.key} (base ${ctx.baseRef}, ${fix ? `fixing, up to ${config.prCheck.maxRounds} rounds` : 'report only'})`);
    const started = Date.now();
    const onProgress = manual ? (loop) => writeProgress(config, ctx.id, { loop }) : undefined;
    const result = await runPrCheck(config, ctx, { fix, resume, onProgress });
    const last = result.history[result.history.length - 1];
    const report = renderReport(ctx, result);

    let pushed = false;
    const commits = result.history.map((h) => h.fix?.commit).filter(Boolean);
    if (flags.push && commits.length && ctx.pr?.fromFork) log('not pushing: the PR comes from a fork; push the fix commits to the fork yourself');
    else if (flags.push && commits.length) {
      pushed = git(ctx.workRoot, ['push', '--quiet', 'origin', `HEAD:${ctx.branch}`]).status === 0;
      log(pushed ? `pushed ${commits.length} fix commit(s) to ${ctx.branch}` : `push to ${ctx.branch} failed`);
    }
    if (flags.comment && ctx.pr) await commentOnPullRequest(config.root, ctx.pr.number, report);

    const out = resultDir(config, ctx.id);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.md'), report);
    const summary = {
      id: ctx.id,
      story: ctx.story.key,
      ...(ctx.multi ? { stories: ctx.tickets.map((t) => t.key), epic: ctx.epic?.key ?? null } : {}),
      lenses: Object.keys(last?.lensScores ?? {}),
      pr: ctx.pr?.url ?? null,
      verdict: result.verdict,
      score: last?.score ?? 0,
      lensScores: last?.lensScores ?? {},
      rounds: result.history.length,
      reason: result.reason,
      openFindings: last?.upheld.map(({ id, lens, severity, title }) => ({ id, lens, severity, title })) ?? [],
      commits,
      pushed,
      report: path.relative(config.root, path.join(out, 'report.md')).replace(/\\/g, '/'),
      runDir: path.relative(config.root, ctx.runDir).replace(/\\/g, '/'),
      seconds: Math.round((Date.now() - started) / 1000),
      finishedAt: nowIso(),
    };
    writeJson(path.join(out, 'result.json'), summary);
    if (manual) writeProgress(config, ctx.id, { pid: null, boot: null, recoveries: 0, retryAt: null, finishedAt: summary.finishedAt });
    if (ctx.workRoot !== config.root) fs.cpSync(ctx.runDir, path.join(out, 'run'), { recursive: true });
    return { ...summary, text: report };
  } catch (error) {
    // A run that fails (rather than dies) is not resumed.
    if (manual && (flags.resume || readProgress(config, ctx.id)?.pid === process.pid)) writeProgress(config, ctx.id, { pid: null, boot: null, finishedAt: nowIso(), error: error.message });
    throw error;
  } finally {
    releaseLock(lock);
    removeCheckout(config, ctx);
  }
}

async function runCheck(config, flags) {
  const { text, ...summary } = await executeCheck(config, flags);
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`${text}\nReport: ${summary.report}`);
  return summary.verdict === 'PASS' ? 0 : 1;
}

function metrics(config, since) {
  const records = readJsonl(metricsFile(config, CHECKS_FILE)).filter((r) => !since || r.ts >= since);
  const targets = new Map();
  for (const r of records) targets.set(r.target, r);
  const finals = [...targets.values()];
  const upheldByLens = {};
  const upheldBySeverity = {};
  for (const r of records) {
    for (const u of r.upheld ?? []) {
      upheldByLens[u.lens] = (upheldByLens[u.lens] ?? 0) + 1;
      upheldBySeverity[u.severity] = (upheldBySeverity[u.severity] ?? 0) + 1;
    }
  }
  const raised = records.reduce((n, r) => n + (r.raised ?? 0), 0);
  const upheld = records.reduce((n, r) => n + (r.upheld?.length ?? 0), 0);
  return {
    rounds: records.length,
    checks: finals.length,
    perfect: finals.filter((r) => r.score === 10).length,
    firstRoundPerfect: records.filter((r) => r.round === 1 && r.score === 10).length,
    averageRounds: finals.length ? Math.round((records.length / finals.length) * 10) / 10 : 0,
    raised,
    upheld,
    upheldRate: raised ? Math.round((upheld / raised) * 100) / 100 : 0,
    upheldByLens,
    upheldBySeverity,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, VALUE_FLAGS);
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig('pr-check');

  switch (command) {
    case 'run':
      return runCheck(config, flags);

    case 'status': {
      const root = path.join(config.root, config.stateDir, 'pr-check');
      const ids = positional.length ? positional : fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'result.json'))) : [];
      if (!ids.length) console.log('No PR checks have run yet.');
      for (const id of ids) {
        const r = readJson(path.join(resultDir(config, id), 'result.json'), null);
        if (!r) {
          console.log(`${id.padEnd(10)} no result`);
          continue;
        }
        console.log(`${id.padEnd(10)} ${r.verdict} ${r.score}/10 after ${r.rounds} round(s), ${r.openFindings.length} open finding(s)  ${r.report}`);
        if (positional.length) for (const f of r.openFindings) console.log(`  - [${f.severity}] ${f.id} ${f.title}`);
      }
      return 0;
    }

    case 'resume': {
      const force = Boolean(flags.force);
      const lines = [...recoverHookRuns(config, { key: positional[0], force }), ...resumeRuns(config, { id: positional[0], force })];
      console.log(lines.join('\n') || 'No interrupted PR checks.');
      return 0;
    }

    case 'metrics': {
      const m = metrics(config, typeof flags.since === 'string' ? flags.since : null);
      if (flags.json) console.log(JSON.stringify(m, null, 2));
      else {
        console.log(`PR checks: ${m.checks} checks, ${m.rounds} rounds (average ${m.averageRounds}), ${m.perfect} reached 10/10, ${m.firstRoundPerfect} on the first round`);
        console.log(`Findings: ${m.raised} raised, ${m.upheld} upheld (rate ${m.upheldRate}); by lens ${Object.entries(m.upheldByLens).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
      }
      return 0;
    }

    case 'hook': {
      const event = positional[0];
      // story-start comes from the `pipeline start` command, not an agent hook, so it resets even when hooks are disabled.
      if (event === 'story-start') {
        resetPrCheck(config, requireStory(config, positional[1]));
        return 0;
      }
      if (isDisabled()) return 0;
      const payload = readPayload();
      const story = activeStory(config);
      if (event === 'stop') {
        const output = story ? hookStop(config, story, payload) : null;
        if (output) process.stdout.write(JSON.stringify(output));
        return 0;
      }
      if (event === 'session-start') {
        process.stdout.write([sessionContext(config, story), ...interruptedRuns(config)].filter(Boolean).join('\n'));
        return 0;
      }
      console.error(`Unknown hook event "${event}".`);
      return 2;
    }

    case 'hook-run': {
      if (typeof flags.hash !== 'string') throw new Error('hook-run needs --hash <impl-hash>');
      return hookRun(config, requireStory(config, positional[0]), flags.hash, executeCheck);
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

runMain(main, 'pr-check');
