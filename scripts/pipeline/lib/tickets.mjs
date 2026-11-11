// The one loader every story reader uses. Stories, bugs, epics and research spikes live on the GitHub
// board (the issue body is the source of truth); `board fetch` and this loader keep a local copy in
// .agent-state/board/<KEY>/ (story.md, meta.json, mockups/). Readers get a story object:
//
//   { key, type, title, slug, file, dir, mockupsDir, planDir, scenario, epic, blockedBy, issue, storySha }
//
// `file` is the cached story.md (relative to the checkout), so `fs.readFileSync(config.abs(story.file))`
// keeps working. A ticket that is not cached is fetched on demand when the board is reachable; until
// the legacy folder (config.tickets.legacyDir) is deleted, a ticket that is not on the board yet is
// imported from it. See docs/ai-pipeline/board.md#fetch-and-the-local-cache.
import fs from 'node:fs';
import path from 'node:path';
import { boardAvailable, cachedKeys, epicChildren, fetchTickets, importLegacy, issueIndex, readMeta, ticketDir, ticketFile } from '../../board/lib/source.mjs';
import { legacyRoot } from '../../board/lib/legacy.mjs';
import { log } from './util.mjs';

export const STORY_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const KEY_IN = /([A-Z][A-Z0-9]*-\d+)/g;
const rel = (config, abs) => path.relative(config.root, abs).split(path.sep).join('/');

let indexMemo = null;
const misses = new Set();
export function resetTicketMemo() {
  indexMemo = null;
  misses.clear();
}

// A story object from a cached ticket's metadata.
export function storyOf(config, meta) {
  const key = meta.key;
  const slug = meta.slug ?? key;
  return {
    key,
    type: meta.type ?? 'story',
    title: meta.title ?? key,
    slug,
    file: rel(config, ticketFile(config, key)),
    dir: rel(config, ticketDir(config, key)),
    mockupsDir: rel(config, path.join(ticketDir(config, key), 'mockups')),
    planDir: config.plansDir ? `${config.plansDir}/${slug}` : null,
    scenario: key.toLowerCase(),
    epic: meta.parent ?? null,
    blockedBy: meta.blockedBy ?? [],
    issue: meta.issue ?? null,
    storySha: meta.storySha ?? null,
  };
}

const cached = (config, key) => {
  const meta = readMeta(config, key);
  return meta && fs.existsSync(ticketFile(config, key)) ? storyOf(config, meta) : null;
};

// Fetches tickets from the board into the cache (on demand, or `refresh` to re-check updatedAt).
// Returns the per-key fetch results; logs warnings and errors.
export function fetchKeys(config, keys, { refresh = false, gh, quiet = false } = {}) {
  if (!keys.length) return [];
  if (!boardAvailable(config)) {
    return keys.map((key) => {
      if (!refresh && cached(config, key)) return { key, status: 'unchanged' };
      if (importLegacy(config, key)) return { key, status: 'legacy-local' };
      if (cached(config, key)) return { key, status: 'offline-cache' };
      return { key, status: 'unavailable', message: `${key} is not cached and the board is not reachable from this checkout (origin is not ${config.tickets.repo}, or PIPELINE_BOARD=0 / PIPELINE_TICKETS_OFFLINE=1)` };
    });
  }
  try {
    indexMemo ??= issueIndex(config, { gh });
  } catch {
    indexMemo = null;
  }
  const results = fetchTickets(config, keys, { refresh, gh, index: indexMemo ?? undefined, log: quiet ? () => {} : (m) => log(m) });
  for (const r of results) {
    if (['missing', 'error'].includes(r.status) && importLegacy(config, r.key)) Object.assign(r, { status: 'legacy-local' });
  }
  return results;
}

// A ticket by key: the cache, else fetched (or imported from the legacy folder). Null when unknown.
// `update` re-checks the board (downloads only when the issue's updatedAt changed); `refresh` always
// downloads again.
export function loadTicket(config, key, { fetch = true, update = false, refresh = false } = {}) {
  if (!key) return null;
  const hit = cached(config, key);
  if (hit && !update && !refresh) return hit;
  if (!fetch) return hit;
  if (!hit && misses.has(`${config.root}\0${key}`)) return null;
  const [result] = fetchKeys(config, [key], { refresh, quiet: !hit });
  const story = cached(config, key);
  if (!story) {
    misses.add(`${config.root}\0${key}`);
    if (result && !['missing', 'unavailable'].includes(result.status) && result.message) log(result.message);
  }
  return story;
}

// The key a CLI argument stands for: PROMO-3, promo-3, PROMO-3-cart-pricing (a slug), a cached
// story.md or ticket folder, an old <KEY>-<title>.md path, or an epic/spike key (epic-..., spike-...).
export function keyOfArg(arg) {
  if (!arg) return null;
  const s = String(arg).replace(/[\\/]+$/, '');
  let base = path.basename(s).replace(/\.md$/, '');
  if (['story', 'meta'].includes(base)) base = path.basename(path.dirname(s));
  if (/^(epic|spike)-[\w-]+$/i.test(base)) return base.toLowerCase();
  return /^([A-Z][A-Z0-9]*-\d+)(?:-|$)/i.exec(base)?.[1]?.toUpperCase() ?? null;
}

export function resolveTicket(config, arg, opts) {
  return loadTicket(config, keyOfArg(arg), opts);
}

// Stories (and bugs) only: epics and spikes are not implemented.
export function resolveStory(config, arg, opts) {
  const t = resolveTicket(config, arg, opts);
  return t && ['story', 'bug'].includes(t.type) ? t : null;
}

export function listTickets(config, { types = null } = {}) {
  return cachedKeys(config)
    .map((key) => cached(config, key))
    .filter((t) => t && (!types || types.includes(t.type)))
    .sort((a, b) => keyOrder(a.key, b.key));
}

// Every cached story and bug, by key. `board fetch --all` fills the cache from the board.
export const listStories = (config) => listTickets(config, { types: ['story', 'bug'] });

export function ticketText(config, story) {
  try {
    return fs.readFileSync(config.abs ? config.abs(story.file) : path.join(config.root, story.file), 'utf8');
  } catch {
    return null;
  }
}

// Epics for reports: key without the `epic-` prefix (as usage rows record it), title, and the story keys
// that are its sub-issues or that its text names.
export function listEpics(config) {
  const all = listTickets(config);
  return all
    .filter((t) => t.type === 'epic')
    .map((e) => {
      const text = ticketText(config, e) ?? '';
      const stories = new Set([...text.matchAll(/\b([A-Z][A-Z0-9]*-\d+)(?!\d)/g)].map((m) => m[1]));
      for (const t of all) if (t.epic === e.key) stories.add(t.key);
      return { key: e.key.replace(/^epic-/, ''), ticket: e.key, title: e.title.replace(/^Epic:\s*/i, ''), file: e.file, stories };
    });
}

export function epicOf(config, key, epics = listEpics(config)) {
  return epics.find((e) => e.stories.has(key)) ?? null;
}

export const keyOrder = (a, b) => {
  const [pa, na] = a.split(/-(?=\d+$)/);
  const [pb, nb] = b.split(/-(?=\d+$)/);
  return pa === pb && na && nb ? Number(na) - Number(nb) : a.localeCompare(b);
};

// Orders stories so each comes after the stories in the list that block it ("Blocked by"), keys in
// order otherwise. Throws on a cycle.
export function orderByBlockers(stories) {
  const sorted = [...stories].sort((a, b) => keyOrder(a.key, b.key));
  const byKey = new Map(sorted.map((s) => [s.key, s]));
  const order = [];
  const mark = new Map();
  const visit = (s, trail) => {
    if (mark.get(s.key) === 'done') return;
    if (mark.get(s.key) === 'visiting') throw new Error(`Dependency cycle between stories: ${[...trail, s.key].join(' -> ')}.`);
    mark.set(s.key, 'visiting');
    for (const dep of (s.blockedBy ?? []).filter((k) => byKey.has(k))) visit(byKey.get(dep), [...trail, s.key]);
    mark.set(s.key, 'done');
    order.push(s);
  };
  for (const s of sorted) visit(s, []);
  return order;
}

// An epic's stories and bugs in Blocked-by order: its sub-issues on the board (fetched), else the cached
// tickets whose parent is the epic.
export function epicTickets(config, epicArg, { fetch = true, refresh = false } = {}) {
  const key = keyOfArg(epicArg)?.startsWith('epic-') ? keyOfArg(epicArg) : `epic-${String(epicArg).toLowerCase().replace(/^epic-/, '')}`;
  let keys = null;
  if (fetch && boardAvailable(config)) {
    try {
      indexMemo ??= issueIndex(config);
      keys = epicChildren(config, key, { index: indexMemo });
      fetchKeys(config, [key, ...keys], { refresh });
    } catch (error) {
      log(`warning: could not list epic ${key} on the board (${error.message.split('\n')[0]}); using the cache`);
    }
  }
  if (!keys) {
    if (fetch && legacyRoot(config)) importLegacy(config, key);
    keys = listTickets(config).filter((t) => t.epic === key).map((t) => t.key);
  }
  return orderByBlockers(keys.map((k) => loadTicket(config, k, { fetch })).filter((t) => t && ['story', 'bug'].includes(t.type)));
}

export function mockupsDir(config, key) {
  const dir = path.join(ticketDir(config, key), 'mockups');
  return fs.existsSync(dir) ? dir : null;
}

// Mockup files of a ticket, relative to the checkout (folder/file), for the PR check's design critic.
export function mockupFiles(config, key) {
  const dir = mockupsDir(config, key);
  if (!dir) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(rel(config, p));
    }
  };
  walk(dir);
  return out.sort();
}

// Ticket keys a set of changed paths points at: a cached ticket, a test plan folder (tests/plans/<slug>/),
// a scenario folder, or an old story file path.
export function keysFromPaths(config, paths) {
  const keys = new Set();
  const cacheDir = `${config.tickets.dir}/`;
  for (const p of paths) {
    if (p.startsWith(cacheDir)) {
      const k = p.slice(cacheDir.length).split('/')[0];
      if (k) keys.add(k);
      continue;
    }
    if (config.plansDir && p.startsWith(`${config.plansDir}/`)) {
      const k = keyOfArg(p.slice(config.plansDir.length + 1).split('/')[0]);
      if (k) keys.add(k);
      continue;
    }
    if (config.scenariosDir && p.startsWith(`${config.scenariosDir}/`)) {
      const k = p.slice(config.scenariosDir.length + 1).split('/')[0].toUpperCase();
      if (STORY_KEY.test(k)) keys.add(k);
      continue;
    }
    if (config.tickets.legacyDir && p.startsWith(`${config.tickets.legacyDir}/`) && p.endsWith('.md')) {
      const k = keyOfArg(p);
      if (k) keys.add(k);
    }
  }
  return keys;
}

// Story keys named in free text (commit messages, branch names, PR titles).
export const keysInText = (text) => new Set([...String(text ?? '').toUpperCase().matchAll(KEY_IN)].map((m) => m[1]));

export function storiesFromPaths(config, paths, { fetch = false } = {}) {
  return [...keysFromPaths(config, paths)].map((k) => loadTicket(config, k, { fetch })).filter((t) => t && ['story', 'bug'].includes(t.type));
}
