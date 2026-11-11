#!/usr/bin/env node
// Implement stage of the AI pipeline: implements every story in a folder headlessly, one worktree and
// branch per story, driving the implementer through the review and QE stages. See docs/ai-pipeline/implement.md.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, runMain } from '../pipeline/lib/cli.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { git } from '../pipeline/lib/git.mjs';
import { metricsFile } from '../pipeline/lib/state.mjs';
import { log, readJsonl, setLogTag, writeJson } from '../pipeline/lib/util.mjs';
import { DECISIONS_FILE, OUTCOMES_FILE, SUBTASK_RUNS_FILE, formatDecisionReport, labelDecisions } from './lib/decisions.mjs';
import { listSubtaskWorktrees, removeWorktree } from './lib/gitops.mjs';
import { describePlan, formatSummary, implementStory, loadRun, plan, runBatch, runsDir } from './lib/implement.mjs';
import { lspAdapter } from './lib/lsp.mjs';

setLogTag('implement');
const SCRIPT = fileURLToPath(import.meta.url);

const USAGE = `Usage: node scripts/implement/implement.mjs <command> [options]

  run <dir|story.md>... [--parallel N] [--base <ref>] [--pr] [--force] [--dry-run]
        implement every <KEY>-<title>.md story given: each gets a worktree and branch, the implementer
        agent, the review loop and verified tests. Stories "Blocked by" another story in the batch run
        after it, stacked on its branch.
  status [story]                 progress of the latest run, with each story's subtasks
  cleanup [story...]             remove the subtask worktrees and branches a failed run left behind
                                 (all stories when none given); stops their language servers
  metrics [--json] [--since <iso-date>]
  decisions [--story KEY] [--json]
                                 the orchestrator's decisions joined with how their subtasks went,
                                 labeled over-provisioned, under-provisioned, bad-split,
                                 should-have-been-self, weak-verification

Internal
  story <KEY> --file <path> --base <ref> --branch <name> --worktree <dir> --result <file> [--merge b1,b2] [--pr]`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, new Set(['parallel', 'base', 'since', 'file', 'branch', 'worktree', 'result', 'merge', 'story']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig('implement');

  switch (command) {
    case 'run': {
      if (!positional.length) {
        console.error(`Give a stories directory or story files.\n\n${USAGE}`);
        return 2;
      }
      if (!flags['dry-run'] && config.baseRef.startsWith('origin/') && git(config.root, ['fetch', '-q', 'origin']).status !== 0) log('git fetch origin failed; using the local refs.');
      const stories = plan(config, positional, { base: flags.base ?? config.baseRef, force: Boolean(flags.force) });
      console.log(describePlan(stories));
      if (flags['dry-run'] || stories.every((s) => s.skip)) return 0;
      const parallel = Math.max(1, Number(flags.parallel ?? config.implement.parallel) || 1);
      const results = await runBatch(config, stories, { parallel, pr: Boolean(flags.pr), script: SCRIPT });
      console.log(`\n${formatSummary(results)}`);
      return results.every((r) => ['done', 'skipped'].includes(r.outcome)) && results.some((r) => r.outcome === 'done') ? 0 : 1;
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
        pr: Boolean(flags.pr),
      }).catch((error) => ({ key, outcome: 'error', reason: error.message }));
      writeJson(flags.result, result);
      return 0;
    }

    case 'status': {
      const dir = runsDir(config);
      const keys = positional.length ? positional : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[A-Z][A-Z0-9]*-\d+\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];
      if (!keys.length) console.log('No implement runs.');
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
      const rows = labelDecisions({ decisions: read(DECISIONS_FILE), runs: read(SUBTASK_RUNS_FILE), outcomes: read(OUTCOMES_FILE) }, config.implement.decisions);
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
