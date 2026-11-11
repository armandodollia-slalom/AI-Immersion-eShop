// `board sync`: the board bookkeeping that does not belong to one pipeline run. Run by hand and at the
// start of every `pipeline implement run`.
//  - Story issues that are closed (a merged PR with `Closes #N` closes its issue) move to Done, and
//    their late outcome is recorded for the implement decision log (PR merged, human commits, BUG-*
//    stories that name them).
//  - Their section on the epic's evidence comment shows Done.
//  - Failed story cards labeled `escalation-resolved` (a human answered the escalation questions) and no
//    longer `needs-human` move back to Ready; `pipeline implement requeue` runs them.
//  - Every epic card moves to the lane its stories call for.
//  - Feature videos the PR demo video workflow published after a story (or epic) reached Pending Review
//    are posted on the story issue and linked from the epic's evidence comment.
//  - The review gate's bookkeeping for bug-fix PRs (scripts/review-gate/lib/sync.mjs): human reopens of
//    triaged tickets, open gated PRs evaluated again. Reopened tickets are listed for `implement requeue`.
import { listItems, setColumn, syncEpicColumns } from './board.mjs';
import { readEpicEvidence, upsertEpicEvidence } from './epics.mjs';
import { featureVideo } from './evidence.mjs';
import { resolvedLabel } from './escalation.mjs';
import { applyEvent, issueComments, latestMarker, postComment } from './flow.mjs';
import { recordLateOutcome } from './outcomes.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { gateConfig, gateOff } from '../../review-gate/lib/config.mjs';
import { realGh } from '../../review-gate/lib/github.mjs';
import { syncGate } from '../../review-gate/lib/sync.mjs';

// The review gate's step of the sync, with the real GitHub. Returns { reopens, regated, reopenedLabel }.
export function reviewGateSync(config, items, { log = () => {} } = {}) {
  const gc = gateConfig(config.root);
  const reopenedLabel = gc.implement.reviewGate?.labels?.reopened ?? 'reopened';
  if (gateOff(gc)) return { reopens: [], regated: [], reopenedLabel };
  const comments = (n) => issueComments(config, n).map((c) => ({ author: c.author?.login ?? c.author ?? null, body: c.body ?? '', createdAt: c.createdAt ?? null }));
  // The base branch's recent log, for reverts of merged gated PRs.
  const baseLog = () => {
    git(config.root, ['fetch', '-q', 'origin']);
    return git(config.root, ['log', '--since=90.days', '--format=%H%x1f%s%x1f%b%x1e', config.baseRef ?? 'origin/main']).stdout.split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => {
      const [sha, subject, body] = e.split('\x1f');
      return { sha, subject, body };
    });
  };
  const r = syncGate(gc, { gh: realGh, items, log, markerOf: (n) => latestMarker(issueComments(config, n)), commentsOf: comments, applyEvent: (key, ev) => applyEvent(config, key, ev, { log }), metricsConfig: config, baseLog });
  return { ...r, reopenedLabel };
}

// Open story cards a human reopened after the gate assessed them (label `reopened`, In Progress):
// `implement requeue` runs them again.
export const reopenedItems = (config, items, label = 'reopened') => items.filter((i) => i.key && i.state !== 'CLOSED' && i.labels.includes(label) && !i.labels.includes(config.board.epicLabel) && i.column === 'inProgress');

// Backfills videos that did not exist yet when the evidence was posted. Returns the keys (and `epic#N`)
// that got one.
export function syncVideos(config, items, { findVideo = (pr, key) => featureVideo(config, { key }, { pr }), log = () => {} } = {}) {
  const added = [];
  for (const epic of items.filter((i) => i.labels.includes(config.board.epicLabel))) {
    let data;
    try {
      data = readEpicEvidence(config, epic.number);
    } catch (error) {
      log(`epic #${epic.number}: evidence not read: ${error.message}`);
      continue;
    }
    if (!data) continue;
    for (const [key, s] of Object.entries(data.stories)) {
      if (!s.pr || s.video || !['review', 'done'].includes(s.status)) continue;
      const found = findVideo(s.pr, key);
      if (!found) continue;
      try {
        if (s.number) postComment(config, s.number, `### Feature video\n\n${found.markdown}`);
        upsertEpicEvidence(config, { epicNumber: epic.number, storyNumber: s.number ?? null, key, story: { video: found.url } });
        added.push(key);
        log(`${key}: feature video linked.`);
      } catch (error) {
        log(`${key}: feature video not linked: ${error.message}`);
      }
    }
    if (data.epic?.pr && !data.epic.video) {
      const found = findVideo(data.epic.pr, `epic #${epic.number}`);
      if (found) {
        try {
          upsertEpicEvidence(config, { epicNumber: epic.number, epic: { video: found.url } });
          added.push(`epic#${epic.number}`);
          log(`epic #${epic.number}: epic PR video linked.`);
        } catch (error) {
          log(`epic #${epic.number}: epic PR video not linked: ${error.message}`);
        }
      }
    }
  }
  return added;
}

export function syncBoard(config, { listStories, log = () => {}, findVideo, gate = reviewGateSync } = {}) {
  const items = listItems(config);
  const done = [];
  const outcomes = [];
  for (const item of items.filter((i) => i.key && i.state === 'CLOSED' && i.column !== 'done' && !i.labels.includes(config.board.epicLabel))) {
    setColumn(config, item.itemId, 'done');
    log(`#${item.number} ${item.key} closed; moved to ${config.board.columns.done}.`);
    item.column = 'done';
    done.push(item.key);
    try {
      if (item.parent) upsertEpicEvidence(config, { epicNumber: item.parent, storyNumber: item.number, key: item.key, story: { status: 'done' } });
    } catch (error) {
      log(`${item.key}: epic evidence not updated: ${error.message}`);
    }
    try {
      const late = recordLateOutcome(config, item.key, { listStories });
      if (late) {
        outcomes.push(item.key);
        log(`${item.key}: outcome recorded (PR ${late.prMerged ? 'merged' : 'not merged'}, ${late.humanCommits ?? '?'} human commit(s)${late.bugStories.length ? `, bugs: ${late.bugStories.join(', ')}` : ''}).`);
      }
    } catch (error) {
      log(`${item.key}: could not record the late outcome: ${error.message}`);
    }
  }
  const { requeued, resolved } = requeueResolved(config, items, { log });
  let gated = { reopens: [], regated: [], reopenedLabel: 'reopened' };
  try {
    gated = gate(config, items, { log });
  } catch (error) {
    log(`review gate: ${error.message.split('\n')[0]}`);
  }
  const reopened = [...new Set([...gated.reopens, ...reopenedItems(config, items, gated.reopenedLabel).map((i) => i.key)])].filter((k) => !resolved.includes(k));
  const epics = syncEpicColumns(config, items, { log });
  const videos = syncVideos(config, items, { log, ...(findVideo ? { findVideo } : {}) });
  return { done, outcomes, epics, videos, requeued, resolved, reopened, regated: gated.regated };
}

// Open story cards a human resolved (`escalation-resolved`, no `needs-human`): Failed ones move to Ready.
// Returns the keys moved and every resolved key (also those already in Ready).
export const resolvedItems = (config, items) => items.filter((i) => i.key && i.state !== 'CLOSED' && i.labels.includes(resolvedLabel(config)) && !i.labels.includes(config.board.blockedLabel) && !i.labels.includes(config.board.epicLabel) && ['failed', 'ready'].includes(i.column));

export function requeueResolved(config, items, { log = () => {} } = {}) {
  const requeued = [];
  const resolved = [];
  for (const item of resolvedItems(config, items)) {
    if (item.column === 'failed') {
      setColumn(config, item.itemId, 'ready');
      item.column = 'ready';
      requeued.push(item.key);
      log(`#${item.number} ${item.key} resolved by a human; moved to ${config.board.columns.ready}.`);
    }
    if (item.column === 'ready') resolved.push(item.key);
  }
  return { requeued, resolved };
}
