#!/usr/bin/env node
// QE stage of the AI pipeline: verified test plans and automated tests. See docs/ai-pipeline/qe.md.
import { parseArgs as parse, readPayload, readStdin, requireStory, runMain } from '../pipeline/lib/cli.mjs';
import { isDisabled, loadConfig } from '../pipeline/lib/config.mjs';
import { changedFiles, fsReader, git, gitReader, mergeBase, revExists } from '../pipeline/lib/git.mjs';
import { loadState, updateState } from '../pipeline/lib/state.mjs';
import { CASE_ID, activeStory, listStories } from '../pipeline/lib/stories.mjs';
import { keysFromPaths, keysInText, loadTicket, storyOf } from '../pipeline/lib/tickets.mjs';
import { selfProcess, setLogTag } from '../pipeline/lib/util.mjs';
import { calibrateCommand, formatLessonsRecovery, lessonsCommand, recoverLessons } from './lib/lessons.mjs';
import { computeMetrics, formatMetrics } from './lib/metrics.mjs';
import { automationFiles, automationStatus, planStatus } from './lib/plans.mjs';
import { automationLoop, formatRecovery, hookStop, planLoop, recoverAll, sessionContext, spawnQe } from './lib/workflows.mjs';

setLogTag('qe');

const USAGE = `Usage: node scripts/qe/qe.mjs <command> [options]

Workflow 1 (story -> verified test plan)
  plan <story...> | --stale | --all [--force] [--resume] [--background]
  check [--changed-from <ref>] [--rev <rev>] [--all] [--pre-push]

Workflow 2 (review-approved implementation -> verified automated tests)
  automate <story> [--impl-hash <h>] [--skip-tests] [--resume] [--background]
  status [story]

Recovery
  resume [story...] [--force]   resume plan and automation runs that died (crash, kill, reboot) from
                                their last round, and (without stories) the lessons run; --force also
                                restarts runs escalated as crashed

Observability and improvement
  metrics [--json] [--since <iso-date>]
  lessons [--dry-run] [--local] [--if-due] [--no-push] [--resume]
  calibrate [--stage plan|automation] [--sample <n>]

Hooks (called by scripts/pipeline/pipeline.mjs)
  hook stop | hook session-start | hook story-start <story>
  git-hook post-commit | post-merge | pre-push`;

const VALUE_FLAGS = new Set(['changed-from', 'rev', 'impl-hash', 'since', 'stage', 'sample']);
const parseArgs = (argv) => parse(argv, VALUE_FLAGS);

// The story for a key: its ticket (cache, else fetched from the board), else, when the board cannot be
// reached, a stand-in built from its plan folder at `reader`'s revision, so the plan is still checked.
function storyForKey(config, key, reader) {
  const ticket = loadTicket(config, key);
  if (ticket) return ['story', 'bug'].includes(ticket.type) ? ticket : null;
  const dir = reader.list(config.plansDir).find((d) => d === key || d.startsWith(`${key}-`));
  return dir ? storyOf(config, { key, type: 'story', slug: dir }) : null;
}

// Stories touched by a set of changed paths (their plan or scenario folder, tests carrying their case
// ids) and by the ticket keys named in `texts` (commit messages, branch names). Stories are not files in
// the repository any more, so a push that changes only code still finds its story through its branch
// and commit messages.
function touchedStories(config, paths, reader, texts = []) {
  const keys = keysFromPaths(config, paths);
  for (const file of paths) {
    if (!config.testExtensions.some((ext) => file.endsWith(ext))) continue;
    for (const match of (reader.read(file) ?? '').matchAll(CASE_ID)) keys.add(match[1]);
  }
  for (const text of texts) for (const key of keysInText(text)) keys.add(key);
  return [...keys]
    .sort()
    .map((key) => storyForKey(config, key, reader))
    .filter(Boolean);
}

// Every story with a plan at `reader`'s revision, plus every cached story.
function allStories(config, reader) {
  const keys = new Set(listStories(config).map((s) => s.key));
  for (const dir of reader.list(config.plansDir)) {
    const key = /^([A-Z][A-Z0-9]*-\d+)(?:-|$)/.exec(dir)?.[1];
    if (key) keys.add(key);
  }
  return [...keys].sort().map((key) => storyForKey(config, key, reader)).filter(Boolean);
}

const commitTexts = (config, from, to) => [git(config.root, ['log', '--format=%s%n%b', `${from}..${to}`]).stdout];

function checkStories(config, stories, reader, { allowMissing = false } = {}) {
  let failed = 0;
  for (const story of stories) {
    const plan = planStatus(config, story, reader);
    const automation = automationStatus(config, story, reader);
    const planOk = plan.state === 'verified' || (allowMissing && plan.state === 'missing');
    const ok = planOk && automation.state !== 'unverified';
    if (!ok) failed++;
    const detail = [...plan.reasons, ...automation.reasons].filter((r) => r !== 'no plan' || !allowMissing).join('; ');
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${story.key.padEnd(10)} plan=${plan.state.padEnd(10)} automation=${automation.state.padEnd(10)} ${detail}`);
  }
  return failed;
}

// Plans and tests for every story touched by the pushed commits must be verified and current. Stories with
// no plan yet pass: nothing starts work on a new story until someone runs `qe plan` or `implement run`.
function prePush(config, input) {
  if (process.env.QE_SKIP === '1') return 0;
  let failed = 0;
  for (const line of input.split('\n').filter(Boolean)) {
    const [localRef, localSha, , remoteSha] = line.split(' ');
    if (!localSha || /^0+$/.test(localSha)) continue;
    const from = /^0+$/.test(remoteSha ?? '') || !revExists(config.root, remoteSha) ? mergeBase(config.root, config.baseRef) : remoteSha;
    const reader = gitReader(config.root, localSha);
    const texts = [localRef ?? '', ...commitTexts(config, from, localSha)];
    failed += checkStories(config, touchedStories(config, changedFiles(config.root, from, localSha), reader, texts), reader, { allowMissing: true });
  }
  if (failed) console.error('\nQE: push blocked. Run `node scripts/qe/qe.mjs plan <story>` (and commit the plan) or re-run `automate`. Bypass once with QE_SKIP=1.');
  return failed ? 1 : 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig('qe');
  if (process.env.QE_REQUIRED_SCORE) config.loops.requiredScore = Number(process.env.QE_REQUIRED_SCORE);

  switch (command) {
    case 'plan': {
      if (flags.background) {
        const args = ['plan', ...positional, ...Object.keys(flags).filter((f) => f !== 'background').map((f) => `--${f}`)];
        const bg = spawnQe(config, positional[0] ?? 'batch', 'plan', args);
        console.log(`Plan run started in the background (pid ${bg.pid}, log ${bg.log}).`);
        return 0;
      }
      let stories = positional.map((arg) => requireStory(config, arg, { update: true }));
      if (flags.stale || flags.all) {
        stories = listStories(config).filter((s) => {
          const state = planStatus(config, s).state;
          return flags.all ? state !== 'verified' : state === 'stale' || state === 'unverified';
        });
      }
      if (stories.length === 0) {
        console.log('No stories to plan.');
        return 0;
      }
      // Stories still waiting in this batch are "queued" under this process, so a crash leaves them
      // recoverable too, not only the one being planned.
      for (const story of stories.slice(1)) {
        updateState(config, story.key, (s) => {
          if (!['running', 'starting'].includes(s.plan.status)) Object.assign(s.plan, { status: 'queued', ...selfProcess(), progress: null });
        });
      }
      let failed = 0;
      for (const story of stories) {
        const result = await planLoop(config, story, { force: Boolean(flags.force), resume: Boolean(flags.resume) });
        console.log(`${story.key}: ${result.status}`);
        if (!['verified', 'busy'].includes(result.status)) failed++;
      }
      return failed ? 1 : 0;
    }

    case 'check': {
      let reader = fsReader(config.root);
      let stories;
      if (flags['pre-push']) return prePush(config, readStdin());
      if (flags.rev) reader = gitReader(config.root, flags.rev);
      if (flags.all) {
        stories = allStories(config, reader);
        return checkStories(config, stories, reader, { allowMissing: true }) ? 1 : 0;
      }
      const from = flags['changed-from'] ? git(config.root, ['merge-base', flags.rev ?? 'HEAD', flags['changed-from']]).stdout.trim() : mergeBase(config.root, config.baseRef);
      const paths = changedFiles(config.root, from, flags.rev);
      const head = flags.rev ?? 'HEAD';
      stories = touchedStories(config, paths, reader, [git(config.root, ['rev-parse', '--abbrev-ref', head]).stdout, ...commitTexts(config, from, head)]);
      if (stories.length === 0) {
        console.log('No stories, plans or story tests changed.');
        return 0;
      }
      return checkStories(config, stories, reader, { allowMissing: true }) ? 1 : 0;
    }

    case 'automate': {
      const story = requireStory(config, positional[0], { fallbackActive: true });
      if (flags.background) {
        const args = ['automate', story.key, ...(flags['impl-hash'] ? ['--impl-hash', flags['impl-hash']] : []), ...(flags['skip-tests'] ? ['--skip-tests'] : []), ...(flags.resume ? ['--resume'] : [])];
        const bg = spawnQe(config, story.key, 'automation', args);
        console.log(`Automation started in the background (pid ${bg.pid}, log ${bg.log}).`);
        return 0;
      }
      const result = await automationLoop(config, story, { implHash: flags['impl-hash'] ?? null, skipTests: Boolean(flags['skip-tests']), resume: Boolean(flags.resume) });
      console.log(`${story.key}: ${result.status}`);
      return ['verified', 'busy'].includes(result.status) ? 0 : 1;
    }

    case 'resume': {
      const keys = positional.length ? positional.map((a) => requireStory(config, a).key) : null;
      const results = recoverAll(config, listStories(config), { keys, force: Boolean(flags.force) });
      for (const r of results) console.log(formatRecovery(r));
      // The lessons run is not tied to a story, so a story-scoped resume leaves it alone.
      const lessons = keys ? null : recoverLessons(config, { force: Boolean(flags.force) });
      if (lessons) console.log(formatLessonsRecovery(lessons));
      if (!results.length && !lessons) console.log(`No interrupted QE runs${keys ? ` for ${keys.join(', ')}` : ''}.`);
      return 0;
    }

    case 'status': {
      const stories = positional.length ? positional.map((a) => requireStory(config, a)) : [activeStory(config)].filter(Boolean);
      const list = stories.length ? stories : listStories(config);
      for (const story of list) {
        const plan = planStatus(config, story);
        const automation = automationStatus(config, story);
        const state = loadState(config, story.key);
        const tests = automationFiles(config, story).tests.size;
        console.log(`${story.key.padEnd(10)} plan=${plan.state.padEnd(10)} cases=${String(plan.plan.cases.length).padEnd(3)} tests=${String(tests).padEnd(3)} automation=${automation.state}/${state.automation.status}`);
        if (stories.length && state.automation.log) console.log(`Automation log: ${state.automation.log}`);
      }
      return 0;
    }

    case 'metrics': {
      const metrics = computeMetrics(config, { since: flags.since });
      console.log(flags.json ? JSON.stringify(metrics, null, 2) : formatMetrics(metrics));
      return 0;
    }

    case 'lessons': {
      const result = await lessonsCommand(config, { dryRun: Boolean(flags['dry-run']), local: Boolean(flags.local), ifDue: Boolean(flags['if-due']), push: !flags['no-push'], resume: Boolean(flags.resume) });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    case 'calibrate': {
      const results = calibrateCommand(config, { stage: flags.stage ?? null, sample: Number(flags.sample ?? 3) });
      console.log(JSON.stringify(results, null, 2));
      return 0;
    }

    case 'hook': {
      if (isDisabled()) return 0;
      const event = positional[0];
      if (event === 'story-start') {
        const story = requireStory(config, positional[1]);
        console.log(`Test plan for ${story.key}: ${planStatus(config, story).state}.`);
        return 0;
      }
      const payload = readPayload();
      const story = activeStory(config);
      if (event === 'stop') {
        const output = story ? hookStop(config, story, payload) : null;
        if (output) process.stdout.write(JSON.stringify(output));
        return 0;
      }
      if (event === 'session-start') {
        const recovered = recoverAll(config, listStories(config));
        const lessons = recoverLessons(config);
        process.stdout.write([sessionContext(config, story, recovered), lessons && formatLessonsRecovery(lessons)].filter(Boolean).join('\n'));
        return 0;
      }
      console.error(`Unknown hook event "${event}".`);
      return 2;
    }

    case 'git-hook': {
      const event = positional[0];
      if (event === 'pre-push') return prePush(config, readStdin());
      // Stories are board issues, not committed files, so a commit never starts a plan: `qe plan <KEY>`
      // does (or `board fetch`, which plans changed stories in the background with qe.autoPlan true).
      if (isDisabled()) return 0;
      if (event === 'post-merge' && git(config.root, ['config', '--bool', 'qe.autoLessons']).stdout.trim() === 'true') {
        spawnQe(config, 'lessons', 'lessons', ['lessons', '--if-due']);
      }
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

runMain(main, 'qe');
