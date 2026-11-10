#!/usr/bin/env node
// Implement stage of the AI pipeline: starts the implementation agent for a story in its own worktree
// and drives it until the review approves. See docs/ai-pipeline/implement.md.
import { parseArgs, requireStory, runMain } from '../pipeline/lib/cli.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { listStories } from '../pipeline/lib/stories.mjs';
import { setLogTag } from '../pipeline/lib/util.mjs';
import { implementMetrics, implementStory, startInBackground, statusLine } from './lib/implement.mjs';

setLogTag('implement');

const USAGE = `Usage: node scripts/implement/implement.mjs <command> [options]

  run <story> [--background] [--max-runs <n>]
                                create the story's worktree and branch, run the implementation agent,
                                and loop on architecture review findings until approved
  status [story]
  metrics [--json] [--since <iso-date>]`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, new Set(['since', 'max-runs']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig('implement');

  switch (command) {
    case 'run': {
      const story = requireStory(config, positional[0]);
      if (flags.background) {
        const bg = startInBackground(config, story);
        console.log(`${story.key}: implementation started in the background (pid ${bg.pid}, log: ${bg.log}).`);
        return 0;
      }
      const result = implementStory(config, story, flags['max-runs'] ? { maxRuns: Number(flags['max-runs']) } : {});
      console.log(`${story.key}: ${result.implement.status} after ${result.implement.runs} run(s) in ${result.implement.worktree} (${result.implement.branch}).`);
      if (result.implement.lastResult) console.log(result.implement.lastResult);
      return ['approved', 'stopped'].includes(result.implement.status) ? 0 : 1;
    }

    case 'status': {
      const stories = positional.length ? positional.map((a) => requireStory(config, a)) : listStories(config);
      for (const story of stories) console.log(statusLine(config, story));
      return 0;
    }

    case 'metrics': {
      const m = implementMetrics(config, { since: flags.since });
      if (flags.json) console.log(JSON.stringify(m, null, 2));
      else console.log(`Implementer runs: ${m.runs} over ${m.stories} stories, ${m.blocked} blocked, ${m.failed} failed, single-run rate ${m.singleRunRate}`);
      return 0;
    }

    case 'hook':
      return 0; // no agent hooks; listed for symmetry with the other stages

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

runMain(main, 'implement');
