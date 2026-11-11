#!/usr/bin/env node
// Board stage of the AI pipeline: keeps the GitHub Project board in step with the pipeline. Pipeline
// events move a story's card through the transition table in lib/flow.mjs. See docs/ai-pipeline/board.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, readPayload, requireStory, runMain } from '../pipeline/lib/cli.mjs';
import { SCRIPTS_DIR, loadConfig } from '../pipeline/lib/config.mjs';
import { currentBranch } from '../pipeline/lib/git.mjs';
import { loadState, updateState } from '../pipeline/lib/state.mjs';
import { activeStory, listStories, resolveStory } from '../pipeline/lib/stories.mjs';
import { log, nowIso, readJson, setLogTag } from '../pipeline/lib/util.mjs';
import { runAgent } from '../pipeline/lib/agents.mjs';
import { COLUMNS, findIssue, isActive, issueItem, listItems, moveStory, project, removeLabel, setup, storyKind, syncEpicAssignees } from './lib/board.mjs';
import { failureComment, resolveCheck, resolvedLabel } from './lib/escalation.mjs';
import { upsertEpicEvidence } from './lib/epics.mjs';
import { captureApiEvidence, featureVideo } from './lib/evidence.mjs';
import { fetchCommand, migrateCommand, newCommand, publishCommand } from './lib/ticket-commands.mjs';
import { EVENTS, SETTLED, applyEvent, bugComment, cardFlow, claimComment, eventsForState, failStory, issueComments, owner, readFlow, testingComment } from './lib/flow.mjs';
import { resolvedItems, syncBoard } from './lib/sync.mjs';
import { gh, currentLogin } from './lib/github.mjs';
import { ensureFields } from '../review-gate/lib/fields.mjs';
import { realGh } from '../review-gate/lib/github.mjs';

setLogTag('board');
const CONFIG_FILE = path.join(SCRIPTS_DIR, 'board', 'config.json');

const USAGE = `Usage: node scripts/board/board.mjs <command> [options]

  setup                         enable issues, create the labels, the project, its columns and views
                                (idempotent). Ticket issues are created by \`new\` and \`migrate --apply\`
  sync                          move closed stories to Done (recording their late outcome), update
                                their epic's evidence, put every epic in the lane its stories call
                                for, and do the review gate's bookkeeping (human reopens, gated PRs);
                                also run at the start of \`pipeline implement run\`

Tickets (the issue body is the source of truth; see docs/ai-pipeline/board.md)
  fetch <KEY...> | --epic <EPIC> | --all [--refresh]
                                download tickets into the local cache (story.md, meta.json,
                                mockups/); unchanged issues (same updatedAt) are skipped
  publish <KEY> [--force]       write the cached story (e.g. with Implementation Notes) back to its issue
  new <file.md|-> [--type story|bug|epic|spike] [--key KEY] [--epic <epic-key>] [--mockups <dir>] [--dry-run]
                                create a ticket issue from Markdown
  migrate [--summary] | --apply | --verify [--allow-unplaced] | --delete-local [--dry-run]
                                move the legacy story folder to the board (dry run by default)

Cards
  mine                          the stories assigned to you and their columns
  claim <story>... [--force] [--takeover] [--how <text>] [--json]
                                claim the cards for this machine (In Progress); refused when another
                                machine holds one in In Progress or Testing, unless --takeover;
                                --force re-claims a card in Pending Review or Done (run it again)
  event <story> <${EVENTS.join('|')}> [--id <id>] [--force] [--takeover]
                                apply a pipeline event (JSON payload on stdin: {"bugs": [...]})
  fail <story> [--id <id>]      Failed lane, needs-human label and the failure comment from the
                                story's implement run record: up to 3 questions for a human (Sonnet),
                                the details collapsed and a Resolved checkbox
  resolve-check <issue> [--actor <login>] [--comment <id>] [--label]
                                validate the answers of the latest failure comment once Resolved is
                                ticked (run by the board-escalation-resolve workflow; issues only):
                                untick and list what is missing, or swap needs-human for
                                escalation-resolved and record the answers under ## Decisions
  clear-resolved <story>        drop the escalation-resolved label (a re-run of the ticket started)
  clear-reopened <story>        drop the reopened label (a re-run of a reopened bug fix started)
  resolved [--json]             the open story cards labeled escalation-resolved without needs-human
                                (what \`board sync\` re-queues); changes nothing
  move <story> <column> [--force]
                                move a card by hand (${COLUMNS.join(', ')}); only forward unless --force
  review <story> [--pr <url>] [--epic-branch <branch>] [--id <id>]
                                move to Pending Review and attach the evidence (API requests and
                                responses, or the UI video) to the issue and to its epic
  epic-pr <epic issue> --pr <url> [--branch <name>] [--video <url>] [--group <id> [--title <text>] [--tickets K1,K2]]
                                record an epic delivered as one branch (or, with --group, one PR group
                                of a bug epic) on the epic's evidence comment
  status [story]
  sync-epic <issue>             give an epic's open stories the epic's assignees (run by the
                                board-epic-assign workflow when an epic is assigned or unassigned)

Hooks (called by the dispatcher)
  hook story-start <story> | hook stop

The pipeline is started by hand (\`pipeline implement run <KEY>\` or \`--epic <EPIC>\`); automatic pickup
(\`board pick\`) was removed and will be reworked later.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, new Set(['pr', 'id', 'how', 'branch', 'video', 'epic-branch', 'epic', 'type', 'key', 'mockups', 'group', 'title', 'tickets', 'actor', 'comment']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (command === 'pick') {
    console.error('`board pick` was removed: start the pipeline by hand with `node scripts/pipeline/pipeline.mjs implement run <KEY>` (or `--epic <EPIC>`). Automatic pickup will be reworked later; see docs/ai-pipeline/board.md.');
    return 2;
  }
  const config = loadConfig('board');
  const str = (v) => (typeof v === 'string' ? v : null);

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
      // The review gate's triage fields (Impact, Complexity, Fix risk, Severity, Confidence, Human reopens).
      try {
        ensureFields(config, realGh, { log: (m) => console.log(m) });
      } catch (error) {
        console.log(`triage fields not set up: ${error.message.split('\n')[0]}`);
      }
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
          const flow = cardFlow(config, story.key);
          if (!flow) console.log(`${story.key}: no issue (run board setup)`);
          else {
            const m = flow.remote;
            console.log(`${story.key}: #${flow.issue.number} in ${lane(config, issueItem(config, flow.issue).column)}${m ? `; last event #${m.seq} ${m.event} by ${m.owner}` : ''}`);
          }
        }
      } catch (error) {
        console.log(`Board unavailable: ${error.message}`);
      }
      return 0;
    }

    case 'sync': {
      // Informational wherever it runs, so an inactive board is not an error.
      if (!isActive(config)) {
        console.log(flags.json ? JSON.stringify({ done: [], requeued: [], resolved: [], reopened: [], outcomes: [], epics: [] }) : 'Board inactive; nothing to sync.');
        return 0;
      }
      const r = syncBoard(config, { listStories, log: (m) => console.log(m) });
      if (flags.json) console.log(JSON.stringify({ done: r.done, requeued: r.requeued, resolved: r.resolved, reopened: r.reopened, outcomes: r.outcomes, epics: r.epics }));
      else console.log(`Board synced: ${r.done.length} story(ies) moved to ${config.board.columns.done}, ${r.requeued.length} resolved story(ies) moved to ${config.board.columns.ready}, ${r.reopened.length} reopened bug fix(es) to re-run, ${r.outcomes.length} late outcome(s) recorded, ${r.epics.length} epic(s) moved.`);
      return 0;
    }

    case 'resolved': {
      if (!isActive(config)) {
        console.log(flags.json ? JSON.stringify({ resolved: [], requeued: [] }) : 'Board inactive; nothing resolved.');
        return 0;
      }
      const items = resolvedItems(config, listItems(config));
      if (flags.json) console.log(JSON.stringify({ resolved: items.map((i) => i.key), requeued: [], columns: Object.fromEntries(items.map((i) => [i.key, i.column])) }));
      else if (!items.length) console.log('No ticket is labeled escalation-resolved without needs-human.');
      else for (const i of items) console.log(`${i.key.padEnd(10)} #${i.number} ${lane(config, i.column)}  ${i.title}`);
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

    case 'claim': {
      // One line per story (JSON with --json, read by `pipeline implement run`). An inactive board or a
      // GitHub error never refuses a claim.
      for (const key of positional) {
        let r;
        if (!isActive(config)) r = { status: 'inactive' };
        else {
          try {
            r = claim(config, key, { force: Boolean(flags.force), takeover: Boolean(flags.takeover), how: str(flags.how) ?? 'pipeline implement run', id: str(flags.id) });
          } catch (error) {
            r = { status: 'error', reason: error.message.split('\n')[0] };
          }
        }
        const o = { key, status: r.status, ...(r.owner ? { owner: r.owner } : {}), ...(r.from !== undefined ? { from: r.from } : {}), ...(r.reason ? { reason: r.reason } : {}) };
        console.log(flags.json ? JSON.stringify(o) : describeClaim(config, o));
      }
      return 0;
    }

    case 'event': {
      requireActive(config);
      const story = requireStory(config, positional[0]);
      const type = positional[1];
      if (!EVENTS.includes(type)) {
        console.error(`Unknown event "${type}"; use one of ${EVENTS.join(', ')}.`);
        return 2;
      }
      const r = applyStoryEvent(config, story, { ...readPayload(), type, id: str(flags.id), force: Boolean(flags.force), takeover: Boolean(flags.takeover) });
      console.log(describe(config, story.key, type, r));
      return 0;
    }

    case 'fail': {
      requireActive(config);
      const story = requireStory(config, positional[0]);
      const result = readJson(path.join(config.root, config.stateDir, 'implement', `${story.key}.json`), {});
      const id = str(flags.id) ?? `failed:${result.finishedAt ?? result.updatedAt ?? nowIso()}`;
      // A replayed failure is not posted again, so its questions are not asked again either.
      const flow = readFlow(config, story.key);
      const replay = Boolean(flow.ids?.[id] && flow.ids[id] <= (flow.applied ?? 0));
      let body = 'The pipeline stopped.';
      if (!replay) {
        let comments = [];
        try {
          const issue = findIssue(config, story.key);
          if (issue) comments = issueComments(config, issue.number);
        } catch (error) {
          log(`${story.key}: could not read the issue's comments: ${error.message}`);
        }
        const text = story.file && fs.existsSync(config.abs(story.file)) ? fs.readFileSync(config.abs(story.file), 'utf8') : null;
        body = failureComment(config, story.key, result, { runAgent, comments, story: text, host: os.hostname(), log });
      }
      const r = failStory(config, story.key, { id, body }, { log });
      if (r.status === 'applied') updateEpic(config, r.issue.number, story.key, { status: 'failed', branch: result.branch, note: `Stopped: ${result.outcome ?? 'no result'}${result.reason ? ` (${result.reason})` : ''}` });
      console.log(describe(config, story.key, 'failed', r));
      return 0;
    }

    case 'resolve-check': {
      // Issues only (github.token in Actions): no project access and no active-board check.
      const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
      if (!number) {
        console.error('Usage: board resolve-check <issue number> [--actor <login>] [--comment <id>] [--label]');
        return 2;
      }
      const r = resolveCheck(config, number, { actor: str(flags.actor), comment: str(flags.comment), viaLabel: Boolean(flags.label) });
      console.log(`#${number}: ${r.status}${r.missing?.length ? ` (${r.missing.join(' ')})` : ''}${r.answers?.length ? ` (${r.answers.map((a) => `${a.id}=${a.choice}`).join(', ')})` : ''}`);
      return 0;
    }

    case 'clear-reopened': {
      requireActive(config);
      const story = requireStory(config, positional[0]);
      const issue = findIssue(config, story.key);
      if (issue) removeLabel(config, issue.number, 'reopened');
      console.log(issue ? `${story.key} (#${issue.number}): reopened removed (re-run started; the reopen stays in its Triage).` : `${story.key} has no issue; nothing to clear.`);
      return 0;
    }

    case 'clear-resolved': {
      requireActive(config);
      const story = requireStory(config, positional[0]);
      const issue = findIssue(config, story.key);
      if (!issue) {
        console.log(`${story.key} has no issue; nothing to clear.`);
        return 0;
      }
      removeLabel(config, issue.number, resolvedLabel(config));
      console.log(`${story.key} (#${issue.number}): ${resolvedLabel(config)} removed (re-run started).`);
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
      else console.log(r.moved ? `${story.key} (#${r.issue.number}) moved to ${config.board.columns[column]}.` : `${story.key} (#${r.issue.number}) stays in ${lane(config, r.from)}${flags.force ? '' : ' (board move only moves forward; --force to move back)'}.`);
      return r ? 0 : 1;
    }

    case 'review': {
      requireActive(config);
      const story = requireStory(config, positional[0]);
      console.log(markReadyForReview(config, story, { pr: str(flags.pr), epicBranch: str(flags['epic-branch']), id: str(flags.id) }).message);
      return 0;
    }

    case 'epic-pr': {
      requireActive(config);
      const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
      if (!number || !str(flags.pr)) {
        console.error('Usage: board epic-pr <epic issue number> --pr <url> [--branch <name>] [--video <url>] [--group <id> [--title <text>] [--tickets K1,K2]]');
        return 2;
      }
      const group = str(flags.group) ? { id: str(flags.group), pr: str(flags.pr), branch: str(flags.branch), title: str(flags.title), tickets: str(flags.tickets)?.split(',').filter(Boolean) ?? null } : null;
      const r = upsertEpicEvidence(config, group ? { epicNumber: number, group } : { epicNumber: number, epic: { pr: str(flags.pr), branch: str(flags.branch), video: str(flags.video) } });
      console.log(`Epic #${number}: evidence comment ${r.created ? 'posted' : 'updated'} (${r.url}).`);
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

const lane = (config, c) => config.board.columns[c] ?? c ?? '(no column)';

function describe(config, key, type, r) {
  switch (r.status) {
    case 'applied':
      return `${key} (#${r.issue.number}) ${r.moved ? 'moved to' : 'stays in'} ${lane(config, r.to)} (${type}, event #${r.seq}).`;
    case 'stale':
      return `${key}: ${type} ignored: event #${r.seq} is not newer than #${r.last}, already applied.`;
    case 'not-allowed':
      return `${key}: ${type} ignored: not allowed from ${lane(config, r.from)}.`;
    case 'not-owner':
    case 'refused':
      return `${key}: ${type} ignored: ${r.owner} holds the card in ${lane(config, r.from)}${type === 'claim' ? ' (--takeover to take it over)' : ''}.`;
    case 'no-issue':
      return `${key} has no issue on the board (run board setup).`;
    default:
      return `${key}: ${type}: ${r.status}`;
  }
}

function describeClaim(config, o) {
  if (o.status === 'inactive') return `${o.key}: board inactive; not claimed.`;
  if (o.status === 'error') return `${o.key}: board unavailable (${o.reason}); not claimed.`;
  if (o.status === 'refused' || o.status === 'not-allowed') return `${o.key}: not claimed: ${o.owner ? `${o.owner} holds it in ${lane(config, o.from)}` : `the card is in ${lane(config, o.from)}`} (--force to take it over).`;
  return `${o.key}: claimed (${o.status}).`;
}

function claim(config, key, { force, takeover, how, id }) {
  const [login, ...host] = owner().split('@');
  return applyEvent(config, key, { type: 'claim', id: id ?? `claim:${nowIso()}`, force, takeover, body: claimComment(config, { who: `@${login} on \`${host.join('@') || os.hostname()}\``, how }) }, { log });
}

// A pipeline event with its comment. `verified` posts the review notes and the evidence.
function applyStoryEvent(config, story, event) {
  if (event.type === 'verified') return markReadyForReview(config, story, { id: event.id, pr: event.pr ?? null, epicBranch: event.epicBranch ?? null }).result;
  if (event.type === 'claim') return claim(config, story.key, { force: event.force, takeover: event.takeover, how: event.how ?? 'board event', id: event.id });
  if (event.type === 'failed') return failStory(config, story.key, { id: event.id, body: event.body ?? 'The pipeline stopped.' }, { log });
  const body = event.type === 'testing' ? testingComment(config) : event.type === 'product-bug' ? bugComment(config, event.bugs ?? [], { cycle: event.cycle }) : null;
  return applyEvent(config, story.key, { type: event.type, id: event.id, force: event.force, body }, { log });
}

function updateEpic(config, number, key, story) {
  try {
    const r = upsertEpicEvidence(config, { storyNumber: number, key, story });
    if (r) log(`${key}: epic #${r.epic} evidence ${r.created ? 'posted' : 'updated'}.`);
  } catch (error) {
    log(`${key}: epic evidence not updated: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Hooks: interactive sessions (`pipeline start <KEY>` ... `pipeline done`). Headless runs
// (`pipeline implement`) report their events from the runner instead, so the hooks skip them.
// ---------------------------------------------------------------------------------------------

function hook(config, [event, key]) {
  readPayload();
  if (!isActive(config) || process.env.PIPELINE_HEADLESS === '1') return 0;
  try {
    if (event === 'story-start') {
      const story = resolveStory(config, key);
      if (!story) return 0;
      updateState(config, story.key, (s) => (s.board = { applied: [], at: nowIso() }));
      const r = claim(config, story.key, { force: false, how: 'pipeline start' });
      if (['applied', 'refused', 'not-allowed'].includes(r.status)) console.log(`Board: ${describe(config, story.key, 'claim', r)}${r.status === 'refused' ? ` Take it over with \`node scripts/board/board.mjs claim ${story.key} --force\`.` : ''}`);
      return 0;
    }
    if (event === 'stop') {
      const story = activeStory(config);
      if (!story) return 0;
      const state = loadState(config, story.key);
      const applied = new Set(state.board?.applied ?? []);
      try {
        for (const ev of eventsForState(state)) {
          if (applied.has(ev.id)) continue;
          const r = applyStoryEvent(config, story, ev);
          log(describe(config, story.key, ev.type, r));
          // Settled events are not reported again; anything else is retried on the next stop.
          if (!SETTLED.has(r.status)) break;
          applied.add(ev.id);
        }
      } finally {
        updateState(config, story.key, (s) => (s.board = { ...s.board, applied: [...applied].slice(-20), at: nowIso() }));
      }
      return 0;
    }
  } catch (error) {
    // The board is informational: a GitHub outage must never block an agent.
    log(`board ${event} skipped: ${error.message}`);
  }
  return 0;
}

// Pending Review: the review notes with the PR and the story's evidence on the issue (API requests and
// responses for [BE] stories, the feature video for [FE] stories), the same links on the epic's
// evidence comment, and `Closes #<issue>` on the PR.
function markReadyForReview(config, story, { pr, epicBranch = null, id = null }) {
  const issue = findIssue(config, story.key);
  if (!issue) return { message: `${story.key} has no issue on the board; nothing to update.`, result: { status: 'no-issue' } };
  const text = fs.readFileSync(path.join(config.root, story.file), 'utf8');
  const kind = storyKind(text);
  const lines = ['## Ready for review', '', ...(pr ? [`Pull request: ${pr}${epicBranch ? ` (merged into the epic branch \`${epicBranch}\`)` : ''}`, ''] : []), '- Architecture review: approved', '- Test plan and automated tests: verified', ''];
  let video = null;
  if (kind === 'ui') {
    const found = featureVideo(config, story, { pr });
    video = found?.url ?? null;
    // The demo video workflow publishes after the PR opens; `board sync` posts the video once it exists.
    lines.push(found ? `### Feature video\n\n${found.markdown}` : '### Feature video\n\n_Pending: the PR demo video workflow records it after the PR opens; `board sync` links it here once it is published._', '');
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
  const state = loadState(config, story.key);
  const verifiedHash = state.automation?.verifiedHash;
  const r = applyEvent(config, story.key, { type: 'verified', id: id ?? (verifiedHash ? `verified:${verifiedHash}` : `verified:${nowIso()}`), body: lines.join('\n') }, { log });
  if (r.status === 'applied') updateEpic(config, issue.number, story.key, { status: 'review', pr, epicBranch, branch: currentBranch(config.root) || null, video, apiEvidence: kind === 'api' ? r.commentUrl : null });
  if (pr) {
    const body = gh(['pr', 'view', pr, '--json', 'body', '-q', '.body']);
    const closes = `Closes #${issue.number}`;
    if (!body.includes(closes)) gh(['pr', 'edit', pr, '--body-file', '-'], { input: `${body.trimEnd()}\n\n${closes}\n` });
  }
  const message = r.status === 'applied' ? `${story.key} (#${issue.number}) ${r.moved ? 'moved to' : 'is in'} ${lane(config, r.to)}; review notes posted.` : describe(config, story.key, 'verified', r);
  return { message, result: r };
}

runMain(main, 'board');
