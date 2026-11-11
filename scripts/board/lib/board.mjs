import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { gh, ghJson, graphql } from './github.mjs';

// Columns in board order. Hooks only move a story forward; `board move` can move it anywhere.
// Backlog is never picked up; Ready is the picker's lane. Failed holds stories the pipeline could not
// finish: it sits after Pending Review so no hook moves a card out of it; a human moves it back to Ready.
export const COLUMNS = ['backlog', 'ready', 'inProgress', 'review', 'failed', 'done'];
// Earlier names of a column: `setup` renames them in place and keeps their cards.
const FORMER_NAMES = { ready: ['Todo'] };
// Removed columns: `setup` deletes them and moves their cards to the given column.
const RETIRED = { Testing: 'inProgress' };
const KEY_TITLE = /^([A-Z][A-Z0-9]*-\d+):/;

export const storyKeyOf = (title) => KEY_TITLE.exec(title ?? '')?.[1] ?? null;
export const columnKey = (config, name) => COLUMNS.find((c) => config.board.columns[c] === name) ?? null;
export const isForward = (from, to) => COLUMNS.indexOf(to) > COLUMNS.indexOf(from ?? 'backlog') || (from == null && to === 'backlog');

// "[FE - ...]" stories change visible UI (they get a video); "[BE - ...]" stories are APIs (they get
// the requests and responses of their verified tests).
export function storyKind(text) {
  const title = /^#\s+(.+)$/m.exec(text ?? '')?.[1] ?? '';
  if (/\[FE\b/.test(title)) return 'ui';
  if (/\[BE\b/.test(title)) return 'api';
  return 'other';
}

// The epic a story belongs to: the `epic-<slug>.md` file its text links to ("Part of: [...](../epic-x.md)").
export const epicSlugOf = (text) => /\]\((?:[^)\s]*\/)?(epic-[\w-]+)\.md\)/.exec(text ?? '')?.[1] ?? null;

const cacheFile = (config) => path.join(config.root, config.stateDir, 'board.json');
const loadCache = (config) => ({ issues: {}, epics: {}, ...readJson(cacheFile(config), {}) });
const saveCache = (config, cache) => writeJson(cacheFile(config), cache);

let activeMemo = null;
// The board is live only when configured, not opted out (PIPELINE_BOARD=0) and the checkout's origin is
// the configured repo, so throwaway test repos and forks never touch the real board.
export function isActive(config) {
  if (activeMemo?.root === config.root) return activeMemo.active;
  let active = Boolean(config.board?.projectNumber) && process.env.PIPELINE_BOARD !== '0';
  if (active) {
    const url = git(config.root, ['remote', 'get-url', 'origin']).stdout.trim().replace(/\.git$/, '');
    active = url.toLowerCase().endsWith(`/${config.board.repo.toLowerCase()}`) || url.toLowerCase().endsWith(`:${config.board.repo.toLowerCase()}`);
  }
  activeMemo = { root: config.root, active };
  return active;
}

let projectMemo = null;
export function project(config) {
  if (projectMemo) return projectMemo;
  const { owner, ownerType, projectNumber, statusField } = config.board;
  const data = graphql(
    `query($owner:String!,$number:Int!,$field:String!){${ownerType}(login:$owner){projectV2(number:$number){id url title field(name:$field){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
    { owner, number: projectNumber, field: statusField },
  );
  const p = data[ownerType].projectV2;
  if (!p?.field?.id) throw new Error(`project ${projectNumber} has no single-select "${statusField}" field; run \`board setup\``);
  projectMemo = { id: p.id, url: p.url, title: p.title, fieldId: p.field.id, options: Object.fromEntries(p.field.options.map((o) => [o.name, o.id])) };
  return projectMemo;
}
export const resetMemo = () => {
  projectMemo = null;
  activeMemo = null;
};

export function findIssue(config, key) {
  const cache = loadCache(config);
  if (cache.issues[key]) return cache.issues[key];
  const found = ghJson(['issue', 'list', '-R', config.board.repo, '--label', config.board.storyLabel, '--state', 'all', '--search', `${key} in:title`, '--json', 'number,title,url', '--limit', '50']);
  const issue = (found ?? []).find((i) => storyKeyOf(i.title) === key);
  if (!issue) return null;
  cache.issues[key] = { number: issue.number, url: issue.url };
  saveCache(config, cache);
  return cache.issues[key];
}

// The issue's item on our project (added if missing) and its current column.
export function issueItem(config, issue) {
  const p = project(config);
  const [owner, name] = config.board.repo.split('/');
  const data = graphql(
    `query($owner:String!,$name:String!,$number:Int!,$field:String!){repository(owner:$owner,name:$name){issue(number:$number){projectItems(first:50){nodes{id project{id} fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`,
    { owner, name, number: issue.number, field: config.board.statusField },
  );
  const item = data.repository.issue.projectItems.nodes.find((n) => n.project.id === p.id);
  if (item) return { id: item.id, column: columnKey(config, item.fieldValueByName?.name) };
  const added = ghJson(['project', 'item-add', String(config.board.projectNumber), '--owner', config.board.owner, '--url', issue.url, '--format', 'json']);
  return { id: added.id, column: null };
}

export function setColumn(config, itemId, column) {
  const p = project(config);
  const name = config.board.columns[column];
  const optionId = p.options[name];
  if (!optionId) throw new Error(`the ${config.board.statusField} field has no "${name}" option; run \`board setup\``);
  gh(['project', 'item-edit', '--id', itemId, '--project-id', p.id, '--field-id', p.fieldId, '--single-select-option-id', optionId]);
}

// Moves a story's card. Without `force` it only moves forward, so replaying a hook never drags a card
// back. Returns null when the story has no issue.
export function moveStory(config, key, column, { force = false } = {}) {
  const issue = findIssue(config, key);
  if (!issue) return null;
  const item = issueItem(config, issue);
  if (item.column === column || (!force && !isForward(item.column, column))) return { issue, from: item.column, to: item.column, moved: false };
  setColumn(config, item.id, column);
  try {
    syncEpicColumns(config);
  } catch {
    // The epic's lane is cosmetic; the next poll or setup catches up.
  }
  return { issue, from: item.column, to: column, moved: true };
}

// The lane an epic sits in, from its stories' lanes: Done when all are done, Pending Review when all are
// in review or done, In Progress once any has started, Ready once any is ready, else Backlog.
export function epicColumn(columns) {
  const started = ['inProgress', 'review', 'done'];
  if (columns.length && columns.every((c) => c === 'done')) return 'done';
  if (columns.length && columns.every((c) => c === 'review' || c === 'done')) return 'review';
  if (columns.some((c) => started.includes(c))) return 'inProgress';
  if (columns.some((c) => c === 'ready')) return 'ready';
  return 'backlog';
}

// Moves every epic card to the lane its stories call for. Returns the epics moved.
export function syncEpicColumns(config, items = listItems(config), { log = () => {} } = {}) {
  const moved = [];
  for (const epic of items.filter((i) => i.labels.includes(config.board.epicLabel))) {
    const stories = items.filter((i) => i.parent === epic.number);
    const target = epicColumn(stories.map((s) => (s.state === 'CLOSED' ? 'done' : s.column)));
    if (epic.column === target) continue;
    setColumn(config, epic.itemId, target);
    epic.column = target;
    moved.push(epic.number);
    log(`epic #${epic.number} moved to ${config.board.columns[target]}`);
  }
  return moved;
}

// Gives an epic's open stories the epic's assignees (adding and removing as needed), so assigning an
// epic assigns all of its stories. Issues only: no project access needed (runs in GitHub Actions).
export function syncEpicAssignees(config, number) {
  const [owner, name] = config.board.repo.split('/');
  const epic = graphql(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){labels(first:30){nodes{name}} assignees(first:20){nodes{login}} subIssues(first:100){nodes{number state assignees(first:20){nodes{login}}}}}}}`,
    { owner, name, number },
  ).repository.issue;
  if (!epic) throw new Error(`#${number} not found in ${config.board.repo}`);
  if (!epic.labels.nodes.some((l) => l.name === config.board.epicLabel)) return [];
  const want = epic.assignees.nodes.map((a) => a.login);
  const changed = [];
  for (const story of epic.subIssues.nodes.filter((s) => s.state === 'OPEN')) {
    const has = story.assignees.nodes.map((a) => a.login);
    const add = want.filter((l) => !has.includes(l));
    const remove = has.filter((l) => !want.includes(l));
    if (!add.length && !remove.length) continue;
    gh(['issue', 'edit', String(story.number), '-R', config.board.repo, ...(add.length ? ['--add-assignee', add.join(',')] : []), ...(remove.length ? ['--remove-assignee', remove.join(',')] : [])]);
    changed.push({ number: story.number, add, remove });
  }
  return changed;
}

export function comment(config, number, body) {
  gh(['issue', 'comment', String(number), '-R', config.board.repo, '--body-file', '-'], { input: body });
}

export function addLabel(config, number, label) {
  gh(['issue', 'edit', String(number), '-R', config.board.repo, '--add-label', label]);
}

// Every issue card on the board, with its column and assignees.
export function listItems(config) {
  const { owner, ownerType, projectNumber, statusField } = config.board;
  const items = [];
  let after = null;
  for (;;) {
    const data = graphql(
      `query($owner:String!,$number:Int!,$field:String!,$after:String){${ownerType}(login:$owner){projectV2(number:$number){items(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}content{... on Issue{number title url state repository{nameWithOwner}assignees(first:20){nodes{login}}labels(first:30){nodes{name}}parent{number}}}}}}}}`,
      { owner, number: projectNumber, field: statusField, after },
    );
    const page = data[ownerType].projectV2.items;
    for (const n of page.nodes) {
      if (!n.content?.number) continue;
      items.push({
        itemId: n.id,
        column: columnKey(config, n.fieldValueByName?.name),
        status: n.fieldValueByName?.name ?? null,
        number: n.content.number,
        title: n.content.title,
        url: n.content.url,
        state: n.content.state,
        repo: n.content.repository.nameWithOwner,
        key: storyKeyOf(n.content.title),
        assignees: n.content.assignees.nodes.map((a) => a.login),
        labels: n.content.labels.nodes.map((l) => l.name),
        parent: n.content.parent?.number ?? null,
      });
    }
    if (!page.pageInfo.hasNextPage) return items;
    after = page.pageInfo.endCursor;
  }
}

// Column a story's pipeline state calls for in the stop hook: Pending Review once its tests are
// verified (headless runs report after the PR exists instead).
export function columnForState(state, { headless = false } = {}) {
  const a = state.automation ?? {};
  if (a.status === 'verified' && !a.requestedHash) return state.done && !headless ? 'review' : null;
  return null;
}

// The comment posted when the pipeline does not finish a story: outcome, reason, findings, branch and
// log, from the implement run record (`.agent-state/implement/<KEY>.json`).
export function failureComment(config, result, { host = 'this machine', maxFindings = 20 } = {}) {
  const r = result ?? {};
  const lines = [`The pipeline stopped: **${r.outcome ?? 'no result'}**${r.reason ? ` (${r.reason})` : ''}.`];
  const findings = Array.isArray(r.findings) ? r.findings : [];
  if (findings.length) {
    lines.push('', '**Findings**', '');
    for (const f of findings.slice(0, maxFindings)) {
      if (typeof f === 'string') lines.push(`- ${f}`);
      else lines.push(`- ${f.subtask ? `[${f.subtask}] ` : ''}${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.issue ?? f.detail ?? JSON.stringify(f)}${f.fix ? ` Fix: ${f.fix}` : ''}${f.screenshot ? ` (screenshot: \`${f.screenshot}\`)` : ''}`);
    }
    if (findings.length > maxFindings) lines.push(`- ... and ${findings.length - maxFindings} more`);
  }
  const where = [r.branch ? `Branch: \`${r.branch}\`.` : '', r.log ? `Log on \`${host}\`: \`${r.log}\`.` : ''].filter(Boolean).join(' ');
  if (where) lines.push('', where);
  lines.push('', `Fix it, remove the \`${config.board.blockedLabel}\` label and move the card back to ${config.board.columns.ready} (\`board move <KEY> ready --force\`) to retry.`);
  return lines.join('\n');
}

// Stories the local pipeline should pick up: open story issues in Ready (never Backlog), assigned to `login`, not
// parked for a human.
export function pickable(config, items, login) {
  const me = login.toLowerCase();
  return items.filter(
    (i) =>
      i.key &&
      i.column === 'ready' &&
      i.state === 'OPEN' &&
      i.repo.toLowerCase() === config.board.repo.toLowerCase() &&
      i.assignees.some((a) => a.toLowerCase() === me) &&
      i.labels.includes(config.board.storyLabel) &&
      !i.labels.includes(config.board.blockedLabel),
  );
}

// ---------------------------------------------------------------------------------------------
// One-time setup: issues on, labels, the project and its columns, and an issue per story
// ---------------------------------------------------------------------------------------------

const LABELS = (config) => [
  [config.board.storyLabel, '5319e7', 'A product story run through the AI pipeline'],
  [config.board.blockedLabel, 'b60205', 'The pipeline could not finish this story; a human needs to look'],
  ['frontend', '1d76db', 'Visible UI work (WebApp)'],
  ['backend', '0e8a16', 'API and service work'],
  [config.board.epicLabel, '3e4b9e', 'A group of stories; its stories are its sub-issues'],
  [config.board.spikeLabel ?? 'spike', 'c5def5', 'A research spike: findings that feed an epic'],
];

const COLUMN_STYLE = {
  backlog: ['GRAY', 'Not ready for implementation; the pipeline never picks these up, even when assigned'],
  ready: ['PURPLE', 'Ready for implementation; your local `board pick` picks up the ones assigned to you'],
  inProgress: ['YELLOW', 'The pipeline is implementing the story'],
  review: ['BLUE', 'Implemented and verified; the PR is waiting for a human review'],
  failed: ['RED', 'The pipeline could not finish the story; see the latest comment, then move it back to Ready to retry'],
  done: ['GREEN', 'Merged'],
};

export function setup(config, { log, writeProjectNumber }) {
  const { repo, owner, projectTitle } = config.board;
  gh(['repo', 'edit', repo, '--enable-issues']);
  log(`issues enabled on ${repo}`);
  for (const [name, color, description] of LABELS(config)) gh(['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']);
  log('labels ready');

  let number = config.board.projectNumber;
  if (!number) {
    const existing = ghJson(['project', 'list', '--owner', owner, '--format', 'json', '--limit', '100']).projects.find((p) => p.title === projectTitle);
    number = existing?.number ?? ghJson(['project', 'create', '--owner', owner, '--title', projectTitle, '--format', 'json']).number;
    config.board.projectNumber = number;
    writeProjectNumber(number);
    log(`project #${number} "${projectTitle}"${existing ? ' (existing)' : ' created'}`);
  }
  const link = run_(() => gh(['project', 'link', String(number), '--owner', owner, '--repo', repo]));
  if (link) log(`project linked to ${repo}`);
  resetMemo();

  ensureColumns(config, log);
  resetMemo();
  log(ensureViews(config));

  // Ticket issues are the source of truth: `board new` and `board migrate --apply` create them (bodies
  // in the board-ticket format, scripts/board/lib/ticket-format.mjs). Setup only gives every card a lane.
  const items = listItems(config);
  let placed = 0;
  for (const item of items.filter((i) => !i.column)) {
    setColumn(config, item.itemId, 'backlog');
    item.column = 'backlog';
    placed++;
  }
  log(`${items.length} card(s) on the board${placed ? `, ${placed} placed in ${config.board.columns.backlog}` : ''}`);
  syncEpicColumns(config, items, { log });
  return project(config).url;
}

function run_(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

// New projects come with Todo / In Progress / Done; the board needs every configured column. Replacing the
// options clears every card's status, so each card's column is noted first and set again afterwards.
function ensureColumns(config, log) {
  const p = project(config);
  const wanted = COLUMNS.map((c) => config.board.columns[c]);
  if (wanted.every((name) => p.options[name]) && !Object.keys(RETIRED).some((name) => p.options[name])) return log('columns ready');
  const singleSelectOptions = COLUMNS.map((c) => ({ name: config.board.columns[c], color: COLUMN_STYLE[c][0], description: COLUMN_STYLE[c][1] }));
  // Renamed and removed columns send their cards to the column that replaces them.
  const renamed = new Map();
  for (const c of COLUMNS) for (const old of FORMER_NAMES[c] ?? []) if (p.options[old] && !p.options[config.board.columns[c]]) renamed.set(old, c);
  for (const [old, c] of Object.entries(RETIRED)) if (p.options[old]) renamed.set(old, c);
  const restore = listItems(config)
    .map((i) => ({ itemId: i.itemId, column: i.column ?? renamed.get(i.status) }))
    .filter((i) => i.column);
  const extras = Object.keys(p.options).filter((name) => !wanted.includes(name) && !renamed.has(name));
  for (const name of extras) singleSelectOptions.push({ name, color: 'GRAY', description: '' });
  const input = JSON.stringify({
    query: 'mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',
    variables: { input: { fieldId: p.fieldId, singleSelectOptions } },
  });
  gh(['api', 'graphql', '--input', '-'], { input });
  resetMemo();
  for (const i of restore) setColumn(config, i.itemId, i.column);
  log(`columns set: ${wanted.join(' | ')}; ${restore.length} card(s) kept in their columns`);
}

// The project's views, in tab order: the first is the default. GitHub can't reorder views, so when the
// order is wrong the managed views are recreated in this order and the old ones deleted.
const VIEWS = (config, f) => [
  { name: 'Epics', layout: 'board', filter: `label:${config.board.epicLabel}`, vertical_group_by: [f.status] },
  { name: 'Stories by epic', layout: 'board', filter: `-label:${config.board.epicLabel}`, group_by: [f.parent], vertical_group_by: [f.status] },
  { name: 'Stories', layout: 'board', filter: `-label:${config.board.epicLabel}`, vertical_group_by: [f.status] },
  { name: 'All items', layout: 'table' },
];
const FORMER_VIEWS = ['View 1', 'Board', 'Board by epic'];

function ensureViews(config) {
  const { owner, ownerType, projectNumber, statusField } = config.board;
  try {
    const p = graphql(
      `query($owner:String!,$number:Int!){${ownerType}(login:$owner){projectV2(number:$number){views(first:50){nodes{id name filter}} fields(first:50){nodes{... on ProjectV2FieldCommon{databaseId name dataType}}}}}}`,
      { owner, number: projectNumber },
    )[ownerType].projectV2;
    const field = (pred) => p.fields.nodes.find(pred)?.databaseId;
    const want = VIEWS(config, { status: field((x) => x.name === statusField), parent: field((x) => x.dataType === 'PARENT_ISSUE') });
    const views = p.views.nodes;
    if (want.every((w, i) => views[i]?.name === w.name)) {
      for (const [i, w] of want.entries()) {
        if (w.filter && views[i].filter !== w.filter) graphql('mutation($id:ID!,$filter:String!){updateProjectV2View(input:{viewId:$id,filter:$filter}){clientMutationId}}', { id: views[i].id, filter: w.filter });
      }
      return `views ready: ${want.map((w) => w.name).join(', ')}`;
    }
    const managed = new Set([...want.map((w) => w.name), ...FORMER_VIEWS]);
    for (const w of want) gh(['api', '-X', 'POST', `${ownerType === 'user' ? 'users' : 'orgs'}/${owner}/projectsV2/${projectNumber}/views`, '--input', '-'], { input: JSON.stringify(w) });
    for (const v of views.filter((v) => managed.has(v.name))) graphql('mutation($id:ID!){deleteProjectV2View(input:{viewId:$id}){clientMutationId}}', { id: v.id });
    const others = views.filter((v) => !managed.has(v.name)).map((v) => `"${v.name}"`);
    return `views rebuilt: ${want.map((w) => w.name).join(', ')}${others.length ? `; drag Epics before ${others.join(', ')} to make it the default` : ''}`;
  } catch (error) {
    return `could not set up the views through the API (${error.message.split('\n')[0]}); add them by hand: ${'Epics (label:epic), Stories by epic (group by Parent issue), Stories'}`;
  }
}
