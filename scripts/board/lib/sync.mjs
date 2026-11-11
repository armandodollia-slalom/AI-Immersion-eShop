// `board sync`: the board bookkeeping that does not belong to one pipeline run. Run by hand and at the
// start of every `pipeline implement run`.
//  - Story issues that are closed (a merged PR with `Closes #N` closes its issue) move to Done, and
//    their late outcome is recorded for the implement decision log (PR merged, human commits, BUG-*
//    stories that name them).
//  - Their section on the epic's evidence comment shows Done.
//  - Every epic card moves to the lane its stories call for.
//  - Feature videos the PR demo video workflow published after a story (or epic) reached Pending Review
//    are posted on the story issue and linked from the epic's evidence comment.
import { listItems, setColumn, syncEpicColumns } from './board.mjs';
import { readEpicEvidence, upsertEpicEvidence } from './epics.mjs';
import { featureVideo } from './evidence.mjs';
import { postComment } from './flow.mjs';
import { recordLateOutcome } from './outcomes.mjs';

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

export function syncBoard(config, { listStories, log = () => {}, findVideo } = {}) {
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
  const epics = syncEpicColumns(config, items, { log });
  const videos = syncVideos(config, items, { log, ...(findVideo ? { findVideo } : {}) });
  return { done, outcomes, epics, videos };
}
