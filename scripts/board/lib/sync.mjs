// `board sync`: the board bookkeeping that does not belong to one pipeline run. Run by hand and at the
// start of every `pipeline implement run`.
//  - Story issues that are closed (a merged PR with `Closes #N` closes its issue) move to Done, and
//    their late outcome is recorded for the implement decision log (PR merged, human commits, BUG-*
//    stories that name them).
//  - Their section on the epic's evidence comment shows Done.
//  - Every epic card moves to the lane its stories call for.
import { listItems, setColumn, syncEpicColumns } from './board.mjs';
import { upsertEpicEvidence } from './epics.mjs';
import { recordLateOutcome } from './outcomes.mjs';

export function syncBoard(config, { listStories, log = () => {} } = {}) {
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
  return { done, outcomes, epics };
}
