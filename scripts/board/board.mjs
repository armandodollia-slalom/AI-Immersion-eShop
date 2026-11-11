#!/usr/bin/env node
// Board stage of the AI pipeline: keeps the GitHub Project board in step with the pipeline and picks up
// the stories assigned to you. See docs/ai-pipeline/board.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, readPayload, requireStory, runMain } from '../pipeline/lib/cli.mjs';
import { INSTALL_ROOT, SCRIPTS_DIR, loadConfig } from '../pipeline/lib/config.mjs';
import { loadState, updateState } from '../pipeline/lib/state.mjs';
import { activeStory, listStories, resolveStory } from '../pipeline/lib/stories.mjs';
import { log, nowIso, readJson, setLogTag, sleep } from '../pipeline/lib/util.mjs';
import { COLUMNS, addLabel, columnForState, comment, failureComment, findIssue, isActive, issueItem, listItems, moveStory, pickable, project, setColumn, setup, storyKind, syncEpicAssignees, syncEpicColumns } from './lib/board.mjs';
import { captureApiEvidence, featureVideo } from './lib/evidence.mjs';
import { recordLateOutcome } from './lib/outcomes.mjs';
import { fetchCommand, migrateCommand, newCommand, publishCommand } from './lib/ticket-commands.mjs';
import { gh, currentLogin } from './lib/github.mjs';

setLogTag('board');
const PIPELINE_CLI = path.join(INSTALL_ROOT, 'scripts/pipeline/pipeline.mjs');
const CONFIG_FILE = path.join(SCRIPTS_DIR, 'board', 'config.json');

const USAGE = `Usage: node scripts/board/board.mjs <command> [options]

  setup                         enable issues, create the labels, the project, its columns and views
                                (idempotent). Tickets are created by \`new\` and \`migrate --apply\`

Tickets (the issue body is the source of truth; see docs/ai-pipeline/board.md)
  fetch <KEY...> | --epic <EPIC> | --all [--refresh]
                                download tickets into the local cache (story.md, meta.json,
                                mockups/); unchanged issues (same updatedAt) are skipped
  publish <KEY> [--force]       write the cached story (e.g. with Implementation Notes) back to its issue
  new <file.md|-> [--type story|bug|epic|spike] [--key KEY] [--epic <epic-key>] [--mockups <dir>] [--dry-run]
                                create a ticket issue from Markdown
  migrate [--summary] | --apply | --verify [--allow-unplaced] | --delete-local [--dry-run]
                                move the legacy story folder to the board (dry run by default)

  pick [--once] [--parallel N] [--interval <sec>] [--dry-run]
                                implement the stories in Ready assigned to you (gh's logged-in user),
                                then keep polling (--once: a single pass)
  mine                          the stories assigned to you and their columns
  move <story> <column> [--force]
                                move a card (${COLUMNS.join(', ')}); only forward unless --force
  review <story> [--pr <url>]   move to Pending Review and attach the evidence (API requests and
                                responses, or the UI video) to the issue
  status [story]
  sync-epic <issue>             give an epic's open stories the epic's assignees (run by the
                                board-epic-assign workflow when an epic is assigned or unassigned)

Hooks (called by the dispatcher)
  hook story-start <story> | hook stop`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, new Set(['parallel', 'interval', 'pr', 'epic', 'type', 'key', 'mockups']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig('board');

  switch (command) {
    case 'hook':
      return hook(config, positional);

    case 'fetch':
      return fetchCommand(config, { keys: positional, epic: typeof flags.epic === 'string' ? flags.epic : null, all: Boolean(flags.all), refresh: Boolean(flags.refresh) });

    case 'publish':
      return positional[0] ? publishCommand(config, { key: positional[0].toUpperCase(), force: Boolean(flags.force) }) : (console.error('Usage: board publish <KEY>'), 2);

    case 'new':
      return newCommand(config, { file: positional[0], type: flags.type, key: flags.key, epic: flags.epic, mockups: flags.mockups, dryRun: Boolean(flags['dry-run']) });

    case 'migrate':
      return migrateCommand(config, flags);

    case 'setup': {
      const url = setup(config, {
        log: (m) => console.log(m),
        writeProjectNumber: (n) => {
          const file = readJson(CONFIG_FILE, {});
          file.board.projectNumber = n;
          fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(file, null, 2)}\n`);
        },
      });
      console.log(`Board: ${url}`);
      return 0;
    }

    case 'status': {
      if (!isActive(config)) {
        console.log('Board inactive (no projectNumber in scripts/board/config.json, PIPELINE_BOARD=0, or origin is not the board repo).');
        return 0;
      }
      try {
        const story = positional[0] ? resolveStory(config, positional[0]) : activeStory(config);
        console.log(`Board: ${project(config).url}`);
        if (story) {
          const issue = findIssue(config, story.key);
          console.log(issue ? `${story.key}: #${issue.number} in ${config.board.columns[issueItem(config, issue).column] ?? '(no column)'}` : `${story.key}: no issue (run board setup)`);
        }
      } catch (error) {
        console.log(`Board unavailable: ${error.message}`);
      }
      return 0;
    }

    case 'mine': {
      requireActive(config);
      const me = currentLogin();
      const items = listItems(config).filter((i) => i.assignees.some((a) => a.toLowerCase() === me.toLowerCase()));
      if (!items.length) console.log(`No stories assigned to ${me}.`);
      for (const i of items) console.log(`${(i.key ?? '-').padEnd(10)} ${String(config.board.columns[i.column] ?? '-').padEnd(15)} #${i.number} ${i.title}${i.labels.includes(config.board.blockedLabel) ? `  [${config.board.blockedLabel}]` : ''}`);
      return 0;
    }

    case 'move': {
      requireActive(config);
      const story = requireStory(config, positional[0]);
      const column = COLUMNS.find((c) => c === positional[1] || config.board.columns[c].toLowerCase() === String(positional[1] ?? '').toLowerCase());
      if (!column) {
        console.error(`Unknown column "${positional[1]}"; use one of ${COLUMNS.join(', ')}.`);
        return 2;
      }
      const r = moveStory(config, story.key, column, { force: Boolean(flags.force) });
      if (!r) console.error(`${story.key} has no issue; run board setup.`);
      else console.log(r.moved ? `${story.key} (#${r.issue.number}) moved to ${config.board.columns[column]}.` : `${story.key} (#${r.issue.number}) stays in ${config.board.columns[r.from] ?? '(no column)'}${flags.force ? '' : ' (hooks only move forward; --force to move back)'}.`);
      return r ? 0 : 1;
    }

    case 'review': {
      requireActive(config);
      const story = requireStory(config, positional[0]);
      console.log(markReadyForReview(config, story, { pr: typeof flags.pr === 'string' ? flags.pr : null }));
      return 0;
    }

    case 'sync-epic': {
      const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
      if (!number) {
        console.error('Usage: board sync-epic <issue number>');
        return 2;
      }
      const changed = syncEpicAssignees(config, number);
      if (!changed.length) console.log(`#${number}: stories already match the epic's assignees (or it is not an epic).`);
      for (const c of changed) console.log(`#${c.number}:${c.add.length ? ` +${c.add.join(', +')}` : ''}${c.remove.length ? ` -${c.remove.join(', -')}` : ''}`);
      return 0;
    }

    case 'pick':
      requireActive(config);
      return pick(config, {
        once: Boolean(flags.once),
        dryRun: Boolean(flags['dry-run']),
        parallel: Math.max(1, Number(flags.parallel ?? config.board.parallel) || 1),
        intervalSec: Math.max(10, Number(flags.interval ?? config.board.pollSec) || 120),
      });

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

function requireActive(config) {
  if (isActive(config)) return;
  console.error('The board is not set up for this checkout: run `node scripts/board/board.mjs setup` (needs `gh auth refresh -s project`), and make sure origin is the board repo and PIPELINE_BOARD is not 0.');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Hooks: In Progress when a story starts, Pending Review once the tests are verified (interactive
// sessions; headless runs report after the PR exists).
// ---------------------------------------------------------------------------------------------

function hook(config, [event, key]) {
  readPayload();
  if (!isActive(config)) return 0;
  try {
    if (event === 'story-start') {
      const story = resolveStory(config, key);
      if (!story) return 0;
      const r = moveStory(config, story.key, 'inProgress');
      updateState(config, story.key, (s) => (s.board = { column: 'inProgress', at: nowIso() }));
      if (r?.moved) console.log(`Board: ${story.key} (#${r.issue.number}) moved to ${config.board.columns.inProgress}.`);
      return 0;
    }
    if (event === 'stop') {
      const story = activeStory(config);
      if (!story) return 0;
      const state = loadState(config, story.key);
      const target = columnForState(state, { headless: process.env.PIPELINE_HEADLESS === '1' });
      if (!target || state.board?.column === target) return 0;
      if (target === 'review') log(markReadyForReview(config, story, {}));
      else {
        const r = moveStory(config, story.key, target);
        if (r?.moved) log(`${story.key} (#${r.issue.number}) moved to ${config.board.columns[target]}.`);
      }
      updateState(config, story.key, (s) => (s.board = { column: target, at: nowIso() }));
      return 0;
    }
  } catch (error) {
    // The board is informational: a GitHub outage must never block an agent.
    log(`board ${event} skipped: ${error.message}`);
  }
  return 0;
}

function markReadyForReview(config, story, { pr }) {
  const r = moveStory(config, story.key, 'review');
  if (!r) return `${story.key} has no issue on the board; nothing to update.`;
  const text = fs.readFileSync(path.join(config.root, story.file), 'utf8');
  const kind = storyKind(text);
  const lines = [`## Ready for review`, '', ...(pr ? [`Pull request: ${pr}`, ''] : []), '- Architecture review: approved', '- Test plan and automated tests: verified', ''];
  if (kind === 'ui') {
    const video = featureVideo(config, story, { pr });
    // TODO(video): drop the placeholder once featureVideo() returns the PR's recording.
    lines.push(video ? `### Feature video\n\n${video}` : '### Feature video\n\n_Pending: the recording will be linked here (the same video as on the PR) once PR videos land._', '');
  }
  if (kind === 'api') {
    let evidence;
    try {
      evidence = captureApiEvidence(config, story) ?? '_No Playwright API tests for this story; the verified .NET tests are in the PR._';
    } catch (error) {
      evidence = `_API evidence capture failed: ${error.message.split('\n')[0]}_`;
    }
    lines.push(evidence, '');
  }
  comment(config, r.issue.number, lines.join('\n'));
  if (pr) {
    const body = gh(['pr', 'view', pr, '--json', 'body', '-q', '.body']);
    const closes = `Closes #${r.issue.number}`;
    if (!body.includes(closes)) gh(['pr', 'edit', pr, '--body-file', '-'], { input: `${body.trimEnd()}\n\n${closes}\n` });
  }
  return `${story.key} (#${r.issue.number}) ${r.moved ? 'moved to' : 'is in'} ${config.board.columns[r.to] ?? config.board.columns.review}; review notes posted.`;
}

// ---------------------------------------------------------------------------------------------
// Picker: the local user's factory
// ---------------------------------------------------------------------------------------------

async function pick(config, { once, dryRun, parallel, intervalSec }) {
  const me = currentLogin();
  console.log(`Picking up stories assigned to ${me} on ${project(config).url}${once || dryRun ? '' : ` (polling every ${intervalSec}s; Ctrl-C to stop)`}.`);
  for (;;) {
    const items = listItems(config);
    // Merged PRs close their issue (`Closes #N`); finish those cards so the board needs no project workflows.
    for (const item of items.filter((i) => i.key && i.state === 'CLOSED' && i.column !== 'done')) {
      if (dryRun) continue;
      setColumn(config, item.itemId, 'done');
      item.column = 'done';
      log(`#${item.number} ${item.key} closed; moved to ${config.board.columns.done}.`);
      try {
        const late = recordLateOutcome(config, item.key, { listStories });
        if (late) log(`${item.key}: outcome recorded (PR ${late.prMerged ? 'merged' : 'not merged'}, ${late.humanCommits ?? '?'} human commit(s)${late.bugStories.length ? `, bugs: ${late.bugStories.join(', ')}` : ''}).`);
      } catch (error) {
        log(`${item.key}: could not record the late outcome: ${error.message}`);
      }
    }
    if (!dryRun) syncEpicColumns(config, items, { log });
    const ready = pickable(config, items, me);
    const batch = [];
    for (const item of ready) {
      const story = resolveStory(config, item.key, { update: true });
      if (!story) {
        if (!dryRun) fail(config, item, `Could not fetch the story for ${item.key} from its issue (\`node scripts/board/board.mjs fetch ${item.key}\` shows why). Fix the issue body, then move the card back to ${config.board.columns.ready}.`);
        continue;
      }
      batch.push({ item, story });
    }
    if (!batch.length) console.log(`${nowIso()} nothing assigned to ${me} in ${config.board.columns.ready}.`);
    else console.log(`${nowIso()} picked up: ${batch.map((b) => `${b.story.key} (#${b.item.number})`).join(', ')}`);

    if (batch.length && !dryRun) {
      // Claim the cards first so another poll (or machine) never picks them twice.
      for (const { item, story } of batch) {
        moveStory(config, story.key, 'inProgress', { force: true });
        comment(config, item.number, `Picked up by @${me}'s pipeline on \`${os.hostname()}\` (\`pipeline implement\`). This card moves to ${config.board.columns.review} with the PR.`);
      }
      spawnSync(process.execPath, [PIPELINE_CLI, 'implement', 'run', ...batch.map((b) => b.story.key), '--pr', '--parallel', String(parallel)], { cwd: config.root, stdio: 'inherit' });
      for (const { item, story } of batch) {
        const result = readJson(path.join(config.root, config.stateDir, 'implement', `${story.key}.json`), {});
        if (result.outcome === 'done') continue;
        fail(config, item, failureComment(config, result, { host: os.hostname() }));
      }
    }
    if (once || dryRun) return 0;
    await sleep(intervalSec * 1000);
  }
}

// A story the pipeline did not finish goes to the Failed lane (the picker never takes it, and no hook
// moves a card out of it) with the reason, and is labeled for a human.
function fail(config, item, message) {
  try {
    if (config.board.columns.failed) setColumn(config, item.itemId, 'failed');
  } catch (error) {
    log(`#${item.number}: could not move to ${config.board.columns.failed}: ${error.message} (run \`board setup\` to create the column)`);
  }
  park(config, item.number, message);
}

function park(config, number, message) {
  comment(config, number, message);
  addLabel(config, number, config.board.blockedLabel);
  log(`#${number}: ${message.split('\n')[0]}`);
}

runMain(main, 'board');
