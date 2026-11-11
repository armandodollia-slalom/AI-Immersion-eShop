#!/usr/bin/env node
// Post-publish review gate for bug-fix PRs. See docs/ai-pipeline/review-gate.md.
//
//   publish --pr <url> --tickets K1,K2 --base <ref>   run by the implement runner right after it opens a
//                                                     fix PR, in the PR's worktree: assess, record, gate
//   status [--pr <url>]                               the gate state recorded on this machine
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../pipeline/lib/agents.mjs';
import { parseArgs, runMain } from '../pipeline/lib/cli.mjs';
import { log, readJson, setLogTag } from '../pipeline/lib/util.mjs';
import { gateConfig, gateOff } from './lib/config.mjs';
import { realGh } from './lib/github.mjs';
import { loadGateState, publishGate } from './lib/publish.mjs';

setLogTag('review-gate');

const USAGE = `Usage: node scripts/review-gate/review-gate.mjs <command> [options]

  publish --pr <url> --tickets K1,K2 --base <ref> [--json]
                                assess a fix PR the pipeline just opened (run from its worktree)
  status [--pr <url>]           the gate state recorded on this machine`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest, new Set(['pr', 'tickets', 'base']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = gateConfig();
  const deps = { gh: realGh, runAgent, log };

  switch (command) {
    case 'publish': {
      const keys = String(flags.tickets ?? '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
      if (typeof flags.pr !== 'string' || !keys.length || typeof flags.base !== 'string') {
        console.error('Usage: review-gate publish --pr <url> --tickets K1,K2 --base <ref>');
        return 2;
      }
      const off = gateOff(config);
      if (off) {
        console.log(`Review gate off (${off}); ${flags.pr} not assessed.`);
        return 0;
      }
      const r = publishGate(config, { pr: flags.pr, keys, base: flags.base }, deps);
      if (flags.json) console.log(JSON.stringify({ pr: flags.pr, severity: r.assessment.severity.level, class: r.assessment.class, action: r.decision.action, approvals: r.decision.approvals, problems: r.problems }));
      else console.log(`${flags.pr}: severity ${r.assessment.severity.level ?? 'unknown'}, ${r.decision.action}${r.decision.action === 'review' ? ` (${r.decision.approvals} approval(s))` : ''}.`);
      return 0;
    }

    case 'status': {
      const dir = path.join(config.root, config.stateDir, 'review-gate');
      const states = typeof flags.pr === 'string' ? [loadGateState(config, flags.pr)].filter(Boolean) : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean) : [];
      if (!states.length) console.log('No fix PR assessed on this machine.');
      for (const s of states) {
        const a = s.assessment;
        console.log(`${s.pr}  ${a?.class ?? '-'}  ${s.gate?.action ?? 'assessed'}${s.gate?.approvals ? ` (${s.gate.approvals} approval(s))` : ''}`);
        for (const t of a?.tickets ?? []) console.log(`  ${t.key.padEnd(10)} ${String(t.severity?.level ?? '-').padEnd(7)} confidence ${t.confidence?.score ?? '-'}${t.confidence?.high ? ' (high)' : ''}  ${t.severity?.explanation ?? ''}`);
      }
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

runMain(main, 'review-gate');
