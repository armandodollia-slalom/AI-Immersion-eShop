// The story card's state machine. Pipeline events (a run claims the ticket, the review approves and QE
// starts, QE finds a product bug, the tests are verified, the run fails, the issue closes) move the
// card through an explicit table of allowed transitions; anything else is ignored.
//
// Every event carries a per-ticket sequence number that only grows. The last applied number is kept in
// a small file under the git common dir (shared by every worktree on this machine) and in a hidden
// marker on the comment each transition posts (so other machines see it). An event whose number is not
// above the last applied one is stale or a replay and is ignored. Event ids (for example
// `testing:<approved hash>`) map to the number they were first given, so the stop hook and the headless
// runner can report the same event any number of times and it applies once.
//
// Board errors are informational: callers log them and never change a pipeline outcome.
import os from 'node:os';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { addLabel, findIssue, issueItem, setColumn, syncEpicColumns } from './board.mjs';
import { currentLogin, gh, ghJson } from './github.mjs';

// Allowed transitions: the lanes each event moves a card from, and the lane it moves it to. Testing ->
// In Progress happens only on a product bug. Review and Done are left only by a forced claim or a
// forced `board move` (a human).
export const TRANSITIONS = {
  claim: { from: [null, 'backlog', 'ready', 'failed', 'inProgress'], forceFrom: ['testing', 'review', 'done'], to: 'inProgress' },
  testing: { from: ['inProgress'], to: 'testing' },
  'product-bug': { from: ['testing', 'inProgress'], to: 'inProgress' },
  verified: { from: ['inProgress', 'testing'], to: 'review' },
  failed: { from: [null, 'backlog', 'ready', 'inProgress', 'testing'], to: 'failed' },
  closed: { from: [null, 'backlog', 'ready', 'inProgress', 'testing', 'review', 'failed'], to: 'done' },
  // A person reopened a triaged bug fix (card moved back, issue reopened, changes requested on its PR):
  // recorded by `board sync` (the review gate), so the next sync does not count it again.
  reopened: { from: ['review', 'done', 'inProgress'], to: 'inProgress' },
};
export const EVENTS = Object.keys(TRANSITIONS);
// Lanes in which a card belongs to the machine that claimed it.
const ACTIVE = new Set(['inProgress', 'testing']);

// The lane an event moves a card to from `from`, or null when the table does not allow it.
export function nextLane(from, event, { force = false } = {}) {
  const t = TRANSITIONS[event];
  if (!t) return null;
  if (t.from.includes(from ?? null) || (force && t.forceFrom?.includes(from))) return t.to;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sequence numbers: local file and hidden comment marker
// ---------------------------------------------------------------------------------------------

const MARKER = /<!-- pipeline-board:(\{.*?\}) -->/;
export const encodeMarker = (m) => `<!-- pipeline-board:${JSON.stringify(m).replace(/--/g, '-\\u002d')} -->`;
export function parseMarker(body) {
  const m = MARKER.exec(body ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// The marker of the latest comment that carries one: the ticket's last applied sequence number and who
// applied it.
export const latestMarker = (comments) => comments.map((c) => parseMarker(c.body)).filter(Boolean).at(-1) ?? null;

export function flowDir(config) {
  const r = git(config.root, ['rev-parse', '--git-common-dir']);
  const common = r.status === 0 && r.stdout.trim() ? path.resolve(config.root, r.stdout.trim()) : path.join(config.root, config.stateDir ?? '.agent-state');
  return path.join(common, 'ai-pipeline', 'board');
}
const flowFile = (config, key) => path.join(flowDir(config), `${key}.json`);
export const readFlow = (config, key) => ({ allocated: 0, applied: 0, ids: {}, ...readJson(flowFile(config, key), {}) });
const writeFlow = (config, key, flow) => {
  // Only the latest ids matter for replays; keep the file small.
  const ids = Object.entries(flow.ids ?? {}).sort((a, b) => a[1] - b[1]).slice(-50);
  writeJson(flowFile(config, key), { ...flow, ids: Object.fromEntries(ids) });
};

// The sequence number of an event: the one its id was given before (a replay), or the next one after
// everything this machine allocated and everything applied anywhere.
export function allocateSeq(flow, id, last) {
  if (id && flow.ids?.[id]) return flow.ids[id];
  const seq = Math.max(flow.allocated ?? 0, last) + 1;
  flow.allocated = seq;
  if (id) flow.ids = { ...flow.ids, [id]: seq };
  return seq;
}

let ownerMemo = null;
// Who applies events from this machine: the gh user and the host name.
export function owner() {
  if (process.env.PIPELINE_BOARD_OWNER) return process.env.PIPELINE_BOARD_OWNER;
  if (!ownerMemo) {
    let login;
    try {
      login = currentLogin();
    } catch {
      login = os.userInfo().username;
    }
    ownerMemo = `${login}@${os.hostname()}`;
  }
  return ownerMemo;
}
export const resetOwner = () => (ownerMemo = null);

export function issueComments(config, number) {
  return ghJson(['issue', 'view', String(number), '-R', config.board.repo, '--json', 'comments'])?.comments ?? [];
}

// Posts a comment and returns its URL.
export function postComment(config, number, body) {
  return gh(['issue', 'comment', String(number), '-R', config.board.repo, '--body-file', '-'], { input: body }).trim();
}

// ---------------------------------------------------------------------------------------------
// Applying an event
// ---------------------------------------------------------------------------------------------

// Applies `event` ({ type, id, force, takeover, body }): `force` lets a claim leave Testing, Pending Review
// or Done (run the story again); `takeover` lets it take a card another machine holds. to the story's card. `body` is the comment posted with
// the transition (the hidden marker is appended); null posts none. Returns { status, ... } where status
// is one of applied, stale, refused (claimed by another machine), not-owner (another machine claimed it
// since), not-allowed (the table forbids it from the current lane), no-issue.
export function applyEvent(config, key, event, { log = () => {} } = {}) {
  if (!TRANSITIONS[event.type]) throw new Error(`unknown board event "${event.type}"; use one of ${EVENTS.join(', ')}`);
  const issue = findIssue(config, key);
  if (!issue) return { status: 'no-issue' };
  const flow = readFlow(config, key);
  const remote = latestMarker(issueComments(config, issue.number)) ?? {};
  const last = Math.max(flow.applied ?? 0, remote.seq ?? 0);
  const seq = allocateSeq(flow, event.id, last);
  writeFlow(config, key, flow);
  if (seq <= last) return { status: 'stale', seq, last, issue };

  const me = owner();
  const item = issueItem(config, issue);
  const from = item.column;
  const holder = ACTIVE.has(from) && remote.owner && remote.owner !== me ? remote.owner : null;
  if (event.type === 'claim' && holder && !event.takeover) return { status: 'refused', owner: holder, from, seq, issue };
  if (!['claim', 'closed', 'reopened'].includes(event.type) && holder) return { status: 'not-owner', owner: holder, from, seq, issue };
  // A machine re-running its own story keeps the card where it is (Testing is left only on a bug).
  const to = event.type === 'claim' && from === 'testing' && !event.force && !holder ? 'testing' : nextLane(from, event.type, { force: event.force || Boolean(event.takeover && holder) });
  if (!to) return { status: 'not-allowed', from, seq, issue };

  if (from !== to) setColumn(config, item.id, to);
  let commentUrl = null;
  if (event.body != null) commentUrl = postComment(config, issue.number, `${event.body}\n\n${encodeMarker({ seq, owner: me, event: event.type, column: to, at: nowIso() })}`);
  writeFlow(config, key, { ...flow, applied: seq, column: to, owner: me });
  if (from !== to) {
    try {
      syncEpicColumns(config);
    } catch (error) {
      log(`epic lane not synced: ${error.message}`);
    }
  }
  return { status: 'applied', from, to, moved: from !== to, seq, issue, commentUrl };
}

// The card's last applied event as other machines see it.
export function cardFlow(config, key) {
  const issue = findIssue(config, key);
  if (!issue) return null;
  return { issue, remote: latestMarker(issueComments(config, issue.number)), local: readFlow(config, key) };
}

// ---------------------------------------------------------------------------------------------
// Comments posted with the transitions
// ---------------------------------------------------------------------------------------------

export function claimComment(config, { who, how }) {
  const c = config.board.columns;
  return `Claimed by ${who} (\`${how}\`). The card moves to **${c.testing}** once the architecture review approves and QE starts, back to **${c.inProgress}** if QE finds a product bug, and to **${c.review}** when the tests are verified.`;
}

export const testingComment = (config) => `Architecture review approved; QE is writing and verifying the automated tests (**${config.board.columns.testing}**).`;

export function bugComment(config, bugs, { cycle = null } = {}) {
  const list = (bugs ?? []).slice(0, 20).map((b) => (typeof b === 'string' ? `- ${b}` : `- ${b.case ? `${b.case}: ` : ''}${b.title ?? b.reason ?? b.issue ?? b.actual ?? JSON.stringify(b)}`));
  if ((bugs ?? []).length > 20) list.push(`- ... and ${bugs.length - 20} more`);
  return [`QE found ${bugs?.length ?? 0} product bug(s)${cycle ? ` (bug-fix cycle ${cycle})` : ''}; the story is back with the implementer (**${config.board.columns.inProgress}**).`, '', ...list].join('\n');
}

// Moves the card to Failed with the failure comment, and labels it for a human.
export function failStory(config, key, { id, body }, opts) {
  const r = applyEvent(config, key, { type: 'failed', id, body }, opts);
  if (r.status === 'applied') addLabel(config, r.issue.number, config.board.blockedLabel);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Interactive sessions: the events the stop hook reports from the story's pipeline state
// ---------------------------------------------------------------------------------------------

// In order: a QE run that found product bugs (the story went back to the implementer), the review
// approving the code QE is now testing, and QE verifying the tests of the finished work.
export function eventsForState(state) {
  const a = state?.automation ?? {};
  const r = state?.review ?? {};
  const events = [];
  if (a.bugs?.length && a.finishedAt && ['product-bug', 'starting'].includes(a.status)) events.push({ type: 'product-bug', id: `bug:${a.finishedAt}`, bugs: a.bugs });
  if (r.lastVerdict === 'APPROVED' && r.approvedHash && ['starting', 'running'].includes(a.status) && a.workingHash === r.approvedHash) events.push({ type: 'testing', id: `testing:${r.approvedHash}` });
  if (a.status === 'verified' && !a.requestedHash && state.done && a.verifiedHash) events.push({ type: 'verified', id: `verified:${a.verifiedHash}` });
  return events;
}

// Statuses after which an event is settled and the stop hook does not report it again.
export const SETTLED = new Set(['applied', 'stale', 'not-allowed', 'not-owner', 'refused', 'no-issue']);
