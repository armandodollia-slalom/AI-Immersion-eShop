#!/usr/bin/env node
// Implement stage of the AI pipeline: implements every story in a folder headlessly, one worktree and
// branch per story, driving the implementer through the review and QE stages. See docs/ai-pipeline/implement.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBackground } from '../pipeline/lib/background.mjs';
import { parseArgs, runMain } from '../pipeline/lib/cli.mjs';
import { isDisabled, loadConfig } from '../pipeline/lib/config.mjs';
import { git } from '../pipeline/lib/git.mjs';
import { clearOutage, readOutage } from '../pipeline/lib/outage.mjs';
import { metricsFile } from '../pipeline/lib/state.mjs';
import { epicTickets, loadTicket } from '../pipeline/lib/tickets.mjs';
import { bootId, isProcessAlive, log, nowIso, readJson, readJsonl, selfProcess, setLogTag, writeJson } from '../pipeline/lib/util.mjs';
import { collectStories } from './lib/batch.mjs';
import { DECISIONS_FILE, OUTCOMES_FILE, PR_CHECKS_FILE, SUBTASK_RUNS_FILE, formatDecisionReport, labelDecisions } from './lib/decisions.mjs';
import { listSubtaskWorktrees, removeWorktree } from './lib/gitops.mjs';
import { board, boardEvent, claimStories, failedResults, skipRefused, syncBoard } from './lib/board-events.mjs';
import { epicBranchFor, epicToJoin, formatEpicStatus, listEpicRuns, loadEpicRun, runEpic } from './lib/epic.mjs';
import { GROUPINGS, deliveryShape } from './lib/epic-plan.mjs';
import { applyEnv, batchFile, describePlan, formatSummary, implementStory, loadRun, plan, runBatch, runsDir, startResolvedReruns } from './lib/implement.mjs';
import { parallelFor } from './lib/resources.mjs';
import { requeue } from './lib/requeue.mjs';
import { lspAdapter } from './lib/lsp.mjs';

setLogTag('implement');
const SCRIPT = fileURLToPath(import.meta.url);

const USAGE = `Usage: node scripts/implement/implement.mjs <command> [options]

  run <KEY...> | --epic <EPIC> [--delivery epic|story] [--grouping auto|epic|ticket] [--standalone]
        [--parallel N|auto] [--base <ref>] [--pr] [--force] [--takeover] [--dry-run]
        implement the given board tickets (fetched into .agent-state/board/; a cached story.md or a
        <KEY>-<title>.md file works too), or every story of an epic in Blocked-by order: each gets a
        worktree and branch, the implementer agent, the review loop and verified tests. Stories "Blocked
        by" another story in the batch run after it, stacked on its branch. The run syncs the board and
        claims each story's card first; a card another machine holds is skipped unless --takeover.
        --force runs stories again that are already implemented (or whose card is in Pending Review or Done).
        Delivery (implement.delivery, default epic): with --epic, the epic is planned once (design note),
        its stories run from one epic branch and merge into it, and the epic gets ONE PR (a bug epic: one
        PR per group of bugs the orchestrator chose; --grouping). --delivery story keeps a branch and PR
        per story. A single ticket of an epic with an epic run in progress joins that epic's branch
        unless --standalone.
  resume [KEY] [--parallel N] [--pr] [--background]
                                 continue the last run that did not finish: stories it finished are
                                 kept, interrupted ones resume in their worktree, the rest run.
                                 --background (used by \`pipeline resume\`) starts it detached, and
                                 only if it was interrupted (and includes KEY, if given)
  requeue [--requeue-only] [--dry-run] [--parallel N|auto] [--no-pr] [--base <ref>]
                                 board sync, then run every ticket a human resolved on GitHub
                                 (escalation-resolved, no needs-human) in one batch (tickets of an epic
                                 run in progress join their delivery unit). No-op when nothing is
                                 resolved, an implement run is active or interrupted here, or the agent
                                 provider is out. --requeue-only moves the cards and starts nothing;
                                 --dry-run prints the plan. Logs to .agent-state/logs/requeue-<time>.log.
  status [story]                 progress of the latest run, with each story's subtasks and each epic run
  cleanup [story...]             remove the subtask worktrees and branches a failed run left behind
                                 (all stories when none given); stops their language servers
  metrics [--json] [--since <iso-date>]
  decisions [--story KEY] [--json]
                                 the orchestrator's decisions joined with how their subtasks went,
                                 labeled over-provisioned, under-provisioned, bad-split,
                                 should-have-been-self, weak-verification

Hooks (called by scripts/pipeline/pipeline.mjs)
  hook session-start             says so when the last implement run was interrupted

Internal
  story <KEY> --file <path> --base <ref> --branch <name> --worktree <dir> --result <file> [--merge b1,b2] [--pr] [--resume]
        [--epic-note <file>] [--epic-branch <branch>]`;

// The epic as the epic runner needs it: key, title, issue number and URL, and its cached ticket.
const epicInfo = (ticket, key) => (ticket ? { ...ticket, number: ticket.issue?.number ?? null, url: ticket.issue?.url ?? null } : { key: String(key).startsWith('epic-') ? key : `epic-${key}`, title: key, number: null, url: null, file: null });

// The batch is saved so `resume` can repeat it after a crash; finishedAt marks a run that completed.
const interruptedBatch = (config) => {
  const batch = readJson(batchFile(config), null);
  return batch && !batch.finishedAt && !isProcessAlive(batch.pid, batch.boot) ? batch : null;
};

async function runStories(config, inputs, { base, force = false, takeover = false, parallel, pr = false, dryRun = false, extraSources = [], epicRun = null, delivery = 'story' }) {
  // Every record this run writes (usage, decisions, outcomes) says how it was delivered.
  process.env.PIPELINE_DELIVERY = delivery;
  // QE leases its own stack slot per story when several run at once (scripts/qe/lib/slots.mjs).
  process.env.IMPLEMENT_PARALLEL = String(parallel);
  const stories = plan(config, inputs, { base, force });
  if (!dryRun) {
    // The board: closed stories to Done and epics in step, then this machine claims the cards it runs.
    syncBoard(config.root);
    const claims = claimStories(config.root, stories.filter((s) => !s.skip).map((s) => s.key), { force, takeover });
    for (const key of skipRefused(stories, claims)) log(`${key}: ${stories.find((s) => s.key === key).skip}; skipped.`);
    startResolvedReruns(config, stories);
  }
  if (epicRun) {
    const { epic, only } = epicRun;
    const join = only ? ` (joining the in-progress run of ${epic.key})` : '';
    console.log(`Delivery: ${epicRun.groups ? 'bug groups' : 'epic'}${join}. ${epicRun.groups ? 'Bug epic: the orchestrator groups the tickets into PRs.' : `One branch ${epicBranchFor(config, epic.key)} and one PR for ${epic.key}.`}`);
    console.log(stories.map((s, i) => `${String(i + 1).padStart(2)}. ${s.key.padEnd(10)} ${s.skip ? `skip: ${s.skip}` : `${s.branch} <- ${epicRun.groups ? 'its group branch' : "the epic's branch"}`}${s.blockedBy.length ? `  (blocked by ${s.blockedBy.join(', ')})` : ''}`).join('\n'));
  } else console.log(describePlan(stories));
  if (dryRun || stories.every((s) => s.skip)) return 0;
  // Agents may read only the tickets handed to this run (scripts/pipeline/lib/story-guard.mjs): a cached
  // ticket's whole folder (story and its own mockups), or the files and folders given.
  // An epic run also hands over the epic's own ticket (its body and mockups).
  process.env.PIPELINE_STORY_SOURCES = [...inputs.map((p) => (path.basename(p) === 'story.md' ? path.dirname(path.resolve(p)) : path.resolve(p))), ...extraSources].join(path.delimiter);
  // One marker for the whole run, shared by its worker and QE processes (outage.mjs). A new run starts
  // clean: the operator resumes once the provider is back.
  process.env.PIPELINE_OUTAGE_FILE = path.join(runsDir(config), 'agent-outage.json');
  clearOutage();
  const batch = { inputs: inputs.map((p) => path.resolve(p)), extraSources, base, parallel, pr, delivery, epic: epicRun ? { key: epicRun.epic.key, only: epicRun.only ?? null, grouping: epicRun.grouping ?? null } : null, ...selfProcess(), startedAt: nowIso(), finishedAt: null };
  writeJson(batchFile(config), batch);
  let results;
  let epicSummary = null;
  if (epicRun) {
    const r = await runEpic(config, { ...epicRun, inputs, base, parallel, pr, force, script: SCRIPT });
    results = r.results;
    epicSummary = r.epic;
  } else results = await runBatch(config, stories, { parallel, pr, script: SCRIPT });
  // An agent provider outage interrupts the run: no card moves to Failed, and the batch stays
  // unfinished so `implement resume` continues it.
  const outage = readOutage(Date.parse(batch.startedAt));
  if (outage) {
    console.log(`\n${formatSummary(results)}`);
    console.log(`\nStopped: the agent provider is unavailable (${outage.cli}, ${outage.agent}: ${outage.reason}).\nUnfinished stories keep their cards. Run \`node scripts/pipeline/pipeline.mjs implement resume\` once it is back.`);
    return 75;
  }
  writeJson(batchFile(config), { ...batch, finishedAt: nowIso() });
  // Every story that did not finish goes to Failed with its outcome, reason and findings.
  // (Epic delivery has no PR per story, so a done story is never failed for a missing PR.)
  for (const r of failedResults(results, { pr: pr && !epicRun })) boardEvent(config.root, r.key, ['fail', r.key]);
  console.log(`\n${formatSummary(results)}`);
  if (epicSummary) console.log(`\n${epicSummary.key}: ${epicSummary.outcome}${epicSummary.prs?.length ? `  ${epicSummary.prs.join(' ')}` : ''}${epicSummary.reason ? `\n           ${epicSummary.reason}` : ''}`);
  const storiesOk = results.every((r) => ['done', 'skipped'].includes(r.outcome)) && results.some((r) => r.outcome === 'done');
  return storiesOk && (!epicSummary || ['done', 'joined'].includes(epicSummary.outcome)) ? 0 : 1;
}

// `pipeline resume` fans out to every stage and waits for each, so the batch restarts detached.
function resumeInBackground(config, key) {
  const batch = interruptedBatch(config);
  if (!batch) {
    console.log('No interrupted implement run.');
    return 0;
  }
  const inputs = batch.inputs.filter((p) => fs.existsSync(p));
  if (key && !collectStories(inputs).some((s) => s.key === key.toUpperCase())) {
    console.log(`The interrupted implement run does not include ${key}.`);
    return 0;
  }
  const bg = spawnBackground(config, { script: SCRIPT, key: 'batch', stage: 'implement', args: ['resume'] });
  // Claimed right away so a second `resume` does not start the batch twice.
  writeJson(batchFile(config), { ...batch, pid: bg.pid, boot: bootId() });
  console.log(`Resumed the interrupted implement run in the background (pid ${bg.pid}, log: ${bg.log}).`);
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, new Set(['parallel', 'base', 'since', 'file', 'branch', 'worktree', 'result', 'merge', 'story', 'epic', 'delivery', 'grouping', 'epic-note', 'epic-branch']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = applyEnv(loadConfig('implement'));

  switch (command) {
    case 'run': {
      // --epic <EPIC> stands for the epic's stories on the board (its sub-issues), fetched into the cache.
      let epicDir = null;
      const delivery = String(flags.delivery ?? config.implement.delivery ?? 'epic');
      if (!['epic', 'story'].includes(delivery)) {
        console.error(`--delivery must be epic or story, not "${delivery}".`);
        return 2;
      }
      const grouping = typeof flags.grouping === 'string' ? flags.grouping : null;
      if (grouping && !GROUPINGS.includes(grouping)) {
        console.error(`--grouping must be one of ${GROUPINGS.join(', ')}.`);
        return 2;
      }
      let epicRun = null;
      if (typeof flags.epic === 'string') {
        const stories = epicTickets(config, flags.epic);
        if (!stories.length) {
          console.error(`Epic ${flags.epic} has no stories on the board (or in the ticket cache).`);
          return 2;
        }
        const epic = stories[0].epic ? loadTicket(config, stories[0].epic, { fetch: false }) : null;
        if (epic) epicDir = config.abs(epic.dir);
        console.log(`Epic ${epic?.key ?? flags.epic}${epic ? ` (${epic.title})` : ''}: ${stories.map((s) => s.key).join(', ')}`);
        positional.push(...stories.map((s) => s.key).filter((k) => !positional.includes(k)));
        if (delivery === 'epic') epicRun = { epic: epicInfo(epic, stories[0].epic ?? flags.epic), tickets: stories, grouping, groups: deliveryShape(stories, grouping ?? config.implement.epic?.grouping ?? 'auto').kind === 'groups' };
      }
      if (!positional.length) {
        console.error(`Give story keys, --epic <EPIC>, or story files.\n\n${USAGE}`);
        return 2;
      }
      // A story key (PROMO-3) stands for its ticket, fetched from the board into the cache (re-checked
      // when already cached, so the run works from the issue's current text).
      const given = [];
      for (const [i, arg] of positional.entries()) {
        if (/^[A-Z][A-Z0-9]*-\d+$/i.test(arg) && !fs.existsSync(arg)) {
          const story = loadTicket(config, arg.toUpperCase(), { update: true });
          if (!story || !['story', 'bug'].includes(story.type)) {
            console.error(`${arg} is not a story on the board (\`node scripts/board/board.mjs fetch ${arg}\` shows why).`);
            return 2;
          }
          positional[i] = config.abs(story.file);
          given.push(story);
        }
      }
      // A single ticket (or a few) of an epic whose epic run is in progress joins that epic's branch
      // (or its PR group's branch) instead of getting a branch and PR of its own, unless --standalone.
      if (!epicRun && delivery === 'epic' && given.length === positional.length) {
        const join = epicToJoin(config, given, { standalone: Boolean(flags.standalone) });
        if (join) {
          const epic = loadTicket(config, join.state.epic, { fetch: false });
          if (epic) epicDir = config.abs(epic.dir);
          epicRun = { epic: epicInfo(epic, join.state.epic), tickets: given, only: given.map((t) => t.key) };
        }
      }
      if (!flags['dry-run'] && config.baseRef.startsWith('origin/') && git(config.root, ['fetch', '-q', 'origin']).status !== 0) log('git fetch origin failed; using the local refs.');
      const parallel = parallelFor(config, flags.parallel, { dryRun: Boolean(flags['dry-run']) });
      return runStories(config, positional, { base: flags.base ?? config.baseRef, force: Boolean(flags.force), takeover: Boolean(flags.takeover), parallel, pr: Boolean(flags.pr), dryRun: Boolean(flags['dry-run']), extraSources: epicDir ? [epicDir] : [], epicRun, delivery: epicRun ? 'epic' : delivery });
    }

    case 'resume': {
      if (flags.background) return resumeInBackground(config, positional[0]);
      const batch = readJson(batchFile(config), null);
      if (!batch) {
        console.log('No implement run to resume.');
        return 0;
      }
      if (!batch.finishedAt && isProcessAlive(batch.pid, batch.boot)) {
        console.error(`The last implement run is still going (pid ${batch.pid}).`);
        return 1;
      }
      const inputs = batch.inputs.filter((p) => fs.existsSync(p));
      if (!inputs.length) {
        console.error(`The stories of the last run are gone: ${batch.inputs.join(', ')}.`);
        return 1;
      }
      const parallel = parallelFor(config, flags.parallel ?? batch.parallel);
      // Labels may have changed since (a human resolved a ticket on GitHub): refresh the cached tickets
      // so plan() sees escalation-resolved.
      for (const s of collectStories(inputs)) if (path.basename(s.file) === 'story.md') loadTicket(config, s.key, { update: true });
      // An epic run resumes from its epic state: the plan, foundation and merged stories are kept.
      let epicRun = null;
      if (batch.epic?.key) {
        const epic = loadTicket(config, batch.epic.key, { fetch: false });
        const tickets = collectStories(inputs).map((s) => loadTicket(config, s.key, { fetch: false })).filter(Boolean);
        epicRun = { epic: epicInfo(epic, batch.epic.key), tickets, only: batch.epic.only ?? null, grouping: batch.epic.grouping ?? null };
      }
      return runStories(config, inputs, { base: batch.base, parallel, pr: Boolean(flags.pr ?? batch.pr), extraSources: batch.extraSources ?? [], epicRun, delivery: batch.delivery ?? 'story' });
    }

    case 'requeue': {
      const logFile = path.join(config.root, config.stateDir, 'logs', `requeue-${nowIso().replace(/[:.]/g, '-')}.log`);
      const dryRun = Boolean(flags['dry-run']);
      if (!dryRun) fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const out = (m) => {
        const line = `${nowIso()} ${m}`;
        console.log(m);
        if (!dryRun) fs.appendFileSync(logFile, `${line}\n`);
      };
      const r = await requeue(
        config,
        { requeueOnly: Boolean(flags['requeue-only']), dryRun, parallel: flags.parallel ?? 'auto', pr: !flags['no-pr'], base: typeof flags.base === 'string' ? flags.base : null },
        {
          log: out,
          board: (args) => board(config.root, args),
          ticketOf: (key) => loadTicket(config, key, { update: true }),
          epicRunOf: (epic) => loadEpicRun(config, epic),
          // Each batch is a normal `implement run`; its output goes to the requeue log.
          runImplement: (args) =>
            new Promise((resolve) => {
              const fd = fs.openSync(logFile, 'a');
              const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: config.root, stdio: ['ignore', fd, fd], env: process.env });
              fs.closeSync(fd);
              child.on('exit', (code) => resolve(code ?? 1));
            }),
        },
      );
      if (!dryRun && r.status !== 'nothing' && r.status !== 'skipped') console.log(`Log: ${path.relative(config.root, logFile)}`);
      return r.exit;
    }

    case 'hook': {
      if (positional[0] !== 'session-start' || isDisabled()) return 0;
      if (interruptedBatch(config)) process.stdout.write('The last implement run was interrupted (crash, kill or reboot). Run `node scripts/pipeline/pipeline.mjs resume` to continue it in the background.');
      return 0;
    }

    case 'story': {
      const key = positional[0];
      const result = await implementStory(config, {
        key,
        file: flags.file,
        base: flags.base,
        branch: flags.branch,
        worktree: flags.worktree,
        merge: flags.merge ? String(flags.merge).split(',') : [],
        epicNote: typeof flags['epic-note'] === 'string' ? flags['epic-note'] : null,
        epicBranch: typeof flags['epic-branch'] === 'string' ? flags['epic-branch'] : null,
        pr: Boolean(flags.pr),
        resume: Boolean(flags.resume),
      }).catch((error) => ({ key, outcome: 'error', reason: error.message }));
      writeJson(flags.result, result);
      return 0;
    }

    case 'status': {
      const dir = runsDir(config);
      const keys = positional.length ? positional : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[A-Z][A-Z0-9]*-\d+\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];
      if (!keys.length && !listEpicRuns(config).length) console.log('No implement runs.');
      if (interruptedBatch(config)) console.log('The last implement run was interrupted. Continue it with `node scripts/pipeline/pipeline.mjs implement resume`.');
      for (const key of keys) {
        const r = loadRun(config, key);
        if (!r) continue;
        console.log(`${key.padEnd(10)} ${String(r.status).padEnd(9)} ${r.outcome ?? '-'}${r.branch ? `  ${r.branch}` : ''}${r.log ? `  log: ${r.log}` : ''}${r.reason ? `\n           ${r.reason}` : ''}`);
        const o = r.orchestration;
        if (o?.mode) {
          console.log(`           ${o.mode}${o.decisionId ? ` (decision ${o.decisionId.slice(0, 8)})` : ''}, ${r.agentRuns ?? o.agentRuns ?? 0} agent runs, ${r.lspCalls ?? o.lspCalls ?? 0} LSP calls${r.signatureChangesWithoutReferences ?? o.signatureChangesWithoutReferences ? ', signature changed without find-references' : ''}`);
          for (const st of o.subtasks ?? []) console.log(`             ${st.id.padEnd(12)} ${String(st.status).padEnd(12)} round ${st.rounds ?? 0}${st.worktree && st.status !== 'merged' ? `  ${st.worktree}` : ''}`);
        }
      }
      if (!positional.length) for (const e of listEpicRuns(config)) console.log(formatEpicStatus(e));
      const left = listSubtaskWorktrees(config.root, config.implement.branchPrefix, positional[0] ?? null);
      if (left.length) console.log(`\nSubtask worktrees still on disk (implement cleanup removes them):\n${left.map((w) => `  ${w.key.padEnd(10)} ${w.id.padEnd(12)} ${w.path}`).join('\n')}`);
      return 0;
    }

    case 'cleanup': {
      const keys = positional.length ? positional : [null];
      const lsp = lspAdapter(config);
      let n = 0;
      for (const key of keys) {
        for (const w of listSubtaskWorktrees(config.root, config.implement.branchPrefix, key)) {
          await lsp.stop(w.path);
          removeWorktree(config.root, w.path, w.branch);
          console.log(`removed ${w.path} (${w.branch})`);
          n++;
        }
      }
      if (!n) console.log('No subtask worktrees to remove.');
      return 0;
    }

    case 'decisions': {
      const read = (f) => readJsonl(metricsFile(config, f)).filter((r) => !flags.story || r.story === flags.story);
      // PR check records of an epic check list every ticket in `stories`.
      const prChecks = readJsonl(metricsFile(config, PR_CHECKS_FILE)).filter((r) => !flags.story || r.story === flags.story || r.stories?.includes(flags.story));
      const rows = labelDecisions({ decisions: read(DECISIONS_FILE), runs: read(SUBTASK_RUNS_FILE), outcomes: read(OUTCOMES_FILE), prChecks }, config.implement.decisions);
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else console.log(formatDecisionReport(rows));
      return 0;
    }

    case 'metrics': {
      const runs = readJsonl(metricsFile(config, 'implement-runs.jsonl')).filter((r) => !flags.since || r.ts >= flags.since);
      const byOutcome = {};
      for (const r of runs) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      const avg = (field) => (runs.length ? Math.round((runs.reduce((n, r) => n + (r[field] ?? 0), 0) / runs.length) * 10) / 10 : 0);
      const orchestrated = runs.filter((r) => r.mode);
      const m = {
        stories: runs.length,
        byOutcome,
        avgImplementerRuns: avg('implementer_runs'),
        avgReviewBlocks: avg('review_blocks'),
        avgMinutes: avg('minutes'),
        orchestrated: orchestrated.length,
        avgAgentRuns: avg('agent_runs'),
        avgLspCalls: avg('lsp_calls'),
        signatureChangesWithoutReferences: runs.filter((r) => r.signature_changes_without_references).length,
        limitsHit: runs.filter((r) => r.limit_hit).length,
      };
      if (flags.json) console.log(JSON.stringify(m, null, 2));
      else {
        console.log(`Implemented stories: ${m.stories} (${Object.entries(byOutcome).map(([o, n]) => `${o}=${n}`).join(' ') || 'none'})`);
        console.log(`Per story: ${m.avgImplementerRuns} implementer runs, ${m.avgReviewBlocks} review rounds blocked, ${m.avgMinutes} min`);
        if (m.orchestrated) console.log(`Orchestrated: ${m.orchestrated} (${m.avgAgentRuns} agent runs, ${m.avgLspCalls} LSP calls per story; ${m.signatureChangesWithoutReferences} changed a signature without find-references; ${m.limitsHit} hit a hard limit)`);
      }
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

runMain(main, 'implement');
