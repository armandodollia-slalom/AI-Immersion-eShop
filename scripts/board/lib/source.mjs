// Fetches board tickets (story, bug, epic, spike issues) into the local cache that every story reader
// uses (scripts/pipeline/lib/tickets.mjs):
//
//   .agent-state/board/<KEY>/story.md     the source Markdown, reconstructed from the issue body
//   .agent-state/board/<KEY>/meta.json    the issue (number, url, updatedAt, state), the body metadata
//   .agent-state/board/<KEY>/mockups/     mockups, downloaded from the assets branch at the pinned commit
//   .agent-state/board/<KEY>/files/       other attachments
//   .agent-state/board/<KEY>/history/     every story.md version seen, by story sha (for plan updates)
//   .agent-state/board/index.json         key -> issue number, so epics and spikes are found by key
//
// An unchanged issue (same updatedAt) is not downloaded again. Offline, the cache is used with a warning;
// a ticket that is neither cached nor on the board is a clear error.
import fs from 'node:fs';
import path from 'node:path';
import { boardDisabled } from '../../pipeline/lib/run-tags.mjs';
import { readJson, writeJson, sha, nowIso } from '../../pipeline/lib/util.mjs';
import { downloadAssets, exec, readAsset } from './assets.mjs';
import { legacyRoot, legacyTicket } from './legacy.mjs';
import { metaFor, parseBody, parseLegacyBody, sha256 } from './ticket-format.mjs';

export class TicketError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const STORY_KEY = /^([A-Z][A-Z0-9]*-\d+):/;
export const ticketsRoot = (config) => path.resolve(config.root, config.tickets.dir);
export const ticketDir = (config, key) => path.join(ticketsRoot(config), key);
export const ticketFile = (config, key) => path.join(ticketDir(config, key), 'story.md');
export const readMeta = (config, key) => readJson(path.join(ticketDir(config, key), 'meta.json'), null);
const indexFile = (config) => path.join(ticketsRoot(config), 'index.json');
// Story sha used by test plans (`story-sha`): the same function as stories.mjs storySha.
const storySha = (text) => sha(text.replace(/\r\n/g, '\n'));

export function cachedKeys(config) {
  const root = ticketsRoot(config);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'meta.json')) && fs.existsSync(path.join(root, d.name, 'story.md')))
    .map((d) => d.name)
    .sort();
}

const defaultGh = (args, opts = {}) => exec('gh', args, opts);

// The board is reachable for this checkout: tickets.repo is origin, and nobody switched it off.
let availableMemo = null;
export function boardAvailable(config, { run = exec } = {}) {
  if (boardDisabled() || process.env.PIPELINE_TICKETS_OFFLINE === '1' || !config.tickets?.repo) return false;
  if (availableMemo?.root === config.root) return availableMemo.value;
  const url = run('git', ['remote', 'get-url', 'origin'], { cwd: config.root }).stdout.trim().replace(/\.git$/, '').toLowerCase();
  const repo = config.tickets.repo.toLowerCase();
  const value = url.endsWith(`/${repo}`) || url.endsWith(`:${repo}`);
  availableMemo = { root: config.root, value };
  return value;
}
export const resetAvailability = () => (availableMemo = null);

function ghJson(gh, args) {
  const r = gh(args);
  if (r.status !== 0) throw new TicketError('offline', `gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr).trim().slice(0, 300)}`);
  const out = String(r.stdout).trim();
  return out ? JSON.parse(out) : null;
}

// Writes a ticket into the cache. `content`: the source text; `meta`: body metadata; `issue`: the issue
// summary (number, url, updatedAt, state, title, labels) or null for a local import.
export function writeTicket(config, key, { content, meta, issue = null, origin = 'board' }) {
  const dir = ticketDir(config, key);
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'story.md'), content);
  fs.writeFileSync(path.join(dir, 'history', `${storySha(content)}.md`), content);
  const contentHash = sha256(Buffer.from(content, 'utf8'));
  writeJson(path.join(dir, 'meta.json'), { ...meta, key, contentHash, storySha: storySha(content), issue, origin, fetchedAt: nowIso() });
  const index = readJson(indexFile(config), { issues: {} });
  if (issue) {
    index.issues[key] = { number: issue.number, url: issue.url, updatedAt: issue.updatedAt };
    writeJson(indexFile(config), index);
  }
  return dir;
}

// Copies a cached ticket (story, meta, history, mockups) into another checkout's cache, e.g. a worktree.
export function copyTicket(fromConfig, toConfig, key) {
  const from = ticketDir(fromConfig, key);
  if (!fs.existsSync(from)) return false;
  const to = ticketDir(toConfig, key);
  if (path.resolve(from) === path.resolve(to)) return true;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

// Every issue on the board repo: number, title, labels, state, updatedAt, url (no bodies).
export function listIssues(config, { gh = defaultGh } = {}) {
  return ghJson(gh, ['issue', 'list', '-R', config.tickets.repo, '--state', 'all', '--limit', '1000', '--json', 'number,title,labels,state,updatedAt,url']).map((i) => ({ ...i, labels: (i.labels ?? []).map((l) => l.name ?? l) }));
}

export function viewIssue(config, number, { gh = defaultGh } = {}) {
  const i = ghJson(gh, ['issue', 'view', String(number), '-R', config.tickets.repo, '--json', 'number,title,body,labels,state,updatedAt,url']);
  return { ...i, labels: (i.labels ?? []).map((l) => l.name ?? l) };
}

// The key an issue stands for: the story key in its title, else the key in its body metadata (epics,
// spikes), else (pre-migration epics) the epic file its body links.
export function keyOfIssue(issue) {
  const fromTitle = STORY_KEY.exec(issue.title ?? '')?.[1];
  if (fromTitle) return fromTitle;
  if (issue.body == null) return null;
  const parsed = safeParse(issue.body);
  if (parsed?.meta?.key) return parsed.meta.key;
  return /\*\*Epic file:\*\*\s*\[`(?:[^`]*\/)?(epic-[\w-]+)\.md`\]/.exec(issue.body)?.[1] ?? null;
}

function safeParse(body) {
  try {
    return parseBody(body);
  } catch {
    return null;
  }
}

// key -> issue summary for every board issue. Story keys come from titles; epics and spikes from their
// bodies (looked up once, then remembered in index.json by issue number).
export function issueIndex(config, { gh = defaultGh } = {}) {
  const saved = readJson(indexFile(config), { issues: {} });
  const byNumber = new Map(Object.entries(saved.issues).map(([k, v]) => [v.number, k]));
  const map = new Map();
  for (const issue of listIssues(config, { gh })) {
    let key = keyOfIssue(issue);
    if (!key && byNumber.has(issue.number)) key = byNumber.get(issue.number);
    if (!key && (issue.labels.includes('epic') || issue.labels.includes('spike'))) {
      const full = viewIssue(config, issue.number, { gh });
      key = keyOfIssue(full);
      if (key) {
        saved.issues[key] = { number: issue.number, url: issue.url, updatedAt: null };
        issue.body = full.body;
      }
    }
    if (key) map.set(key, issue);
  }
  writeJson(indexFile(config), saved);
  return map;
}

// Reconstructs the source of an issue: inline text, a spilled asset, or (before migration) a best-effort
// reading of the old body. Returns { content, meta, legacy, edited }.
export function sourceOfIssue(config, issue, key, { run = exec, gh = defaultGh } = {}) {
  const parsed = parseBody(issue.body);
  if (parsed.legacy) {
    const content = parseLegacyBody(issue.body, issue.title);
    const type = issue.labels.includes('epic') ? 'epic' : issue.labels.includes('spike') ? 'spike' : issue.labels.includes('bug') || key.startsWith('BUG-') ? 'bug' : 'story';
    return { content, meta: { ...metaFor({ key, type, title: issue.title, slug: null }, content), legacy: true }, legacy: true, edited: false };
  }
  if (parsed.spilled) {
    const data = readAsset(config, parsed.meta.assets.commit, parsed.spilled, { run, gh: (args) => gh(args, { binary: true }) });
    if (sha256(data) !== parsed.meta.sourceHash) throw new TicketError('corrupt', `${key}: spilled source ${parsed.spilled} does not match its sha256`);
    return { content: data.toString('utf8'), meta: parsed.meta, legacy: false, edited: false };
  }
  return { content: parsed.content, meta: parsed.meta, legacy: false, edited: parsed.edited };
}

const issueSummary = (i) => ({ number: i.number, url: i.url, updatedAt: i.updatedAt, state: i.state, title: i.title, labels: i.labels });

// Fetches tickets by key into the cache. Returns one result per key:
// { key, status: fetched | unchanged | offline-cache | legacy-local | missing | error, message }.
// Options: refresh (ignore updatedAt), gh/run (injected runners), log.
export function fetchTickets(config, keys, { refresh = false, gh = defaultGh, run = exec, log = () => {}, index = null } = {}) {
  const results = [];
  let map = index;
  if (!map) {
    try {
      map = issueIndex(config, { gh });
    } catch (error) {
      for (const key of keys) {
        if (readMeta(config, key) && fs.existsSync(ticketFile(config, key))) {
          log(`warning: GitHub unreachable (${error.message.split('\n')[0]}); using the cached ${key} from ${readMeta(config, key).fetchedAt}`);
          results.push({ key, status: 'offline-cache', message: error.message });
        } else results.push({ key, status: 'error', message: `cannot reach GitHub to fetch ${key} and it is not cached: ${error.message}` });
      }
      return results;
    }
  }
  for (const key of keys) {
    const summary = map.get(key);
    if (!summary) {
      results.push({ key, status: 'missing', message: `${key} has no issue on ${config.tickets.repo}. Create it with \`node scripts/board/board.mjs new\`, or migrate the local files with \`board migrate --apply\`.` });
      continue;
    }
    const cached = readMeta(config, key);
    if (!refresh && cached?.issue?.updatedAt === summary.updatedAt && fs.existsSync(ticketFile(config, key)) && !cached.legacy) {
      results.push({ key, status: 'unchanged' });
      continue;
    }
    try {
      const issue = summary.body != null ? summary : viewIssue(config, summary.number, { gh });
      const src = sourceOfIssue(config, issue, key, { run, gh });
      // Before migration, the local legacy file is the better copy of an old-format issue.
      if (src.legacy && legacyRoot(config)) {
        const local = importLegacy(config, key, { issue: issueSummary(issue) });
        if (local) {
          results.push({ key, status: 'legacy-local', message: `${key}: the issue is not migrated yet; using the local file` });
          continue;
        }
      }
      // Local edits to the cached story (for example the implementer's Implementation Notes) are never
      // overwritten silently: the issue changed too, so this is a conflict until someone publishes the
      // local copy or discards it with --refresh.
      const local = fs.existsSync(ticketFile(config, key)) ? fs.readFileSync(ticketFile(config, key), 'utf8') : null;
      if (local != null && cached && sha256(Buffer.from(local, 'utf8')) !== cached.contentHash && !refresh) {
        const message = `${key} changed on GitHub and has unpublished local edits in ${path.relative(config.root, ticketFile(config, key))}; keeping the local copy (publish it with \`board publish ${key}\`, or --refresh to take GitHub's)`;
        log(`warning: ${message}`);
        results.push({ key, status: 'conflict', message });
        continue;
      }
      writeTicket(config, key, { content: src.content, meta: { ...src.meta, edited: src.edited }, issue: issueSummary(issue) });
      const dir = ticketDir(config, key);
      if (src.meta.assets?.files?.length) {
        downloadAssets(config, src.meta.assets, path.join(dir, 'mockups'), { run, filter: (f) => f.kind === 'mockup' });
        downloadAssets(config, src.meta.assets, path.join(dir, 'files'), { run, filter: (f) => f.kind === 'file' });
      }
      results.push({ key, status: 'fetched', message: src.edited ? 'edited on GitHub since migration' : undefined });
    } catch (error) {
      if (cached && fs.existsSync(ticketFile(config, key))) {
        log(`warning: could not refresh ${key} (${error.message.split('\n')[0]}); using the cached copy`);
        results.push({ key, status: 'offline-cache', message: error.message });
      } else results.push({ key, status: 'error', message: error.message });
    }
  }
  return results;
}

// The keys of an epic's tickets: its sub-issues on GitHub.
export function epicChildren(config, epicKey, { gh = defaultGh, index = null } = {}) {
  const map = index ?? issueIndex(config, { gh });
  const epic = map.get(epicKey);
  if (!epic) throw new TicketError('missing', `epic ${epicKey} has no issue on ${config.tickets.repo}`);
  const [owner, name] = config.tickets.repo.split('/');
  const data = ghJson(gh, ['api', 'graphql', '-f', `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){subIssues(first:100){nodes{number title}}}}}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${epic.number}`]);
  const numbers = new Set(data.data.repository.issue.subIssues.nodes.map((n) => n.number));
  return [...map.entries()].filter(([, i]) => numbers.has(i.number)).map(([k]) => k);
}

// Imports a ticket from the legacy folder into the cache (until the folder is deleted).
export function importLegacy(config, key, { issue = null } = {}) {
  const t = legacyTicket(config, key);
  if (!t) return null;
  const meta = metaFor(t, t.text, { assets: { repo: config.tickets.repo, branch: null, commit: null, files: t.assets.map(({ path: p, name, kind, sha256: h, size }) => ({ path: p, name, kind, sha256: h, size })) } });
  const dir = writeTicket(config, key, { content: t.text, meta, issue, origin: 'local' });
  const root = legacyRoot(config);
  for (const a of t.assets) {
    const target = path.join(dir, a.kind === 'mockup' ? 'mockups' : 'files', a.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, a.source), target);
  }
  return dir;
}

// Previous versions of a story by story sha: the local history first, then the issue's edit history.
export function storyVersion(config, key, storyShaWanted, { gh = defaultGh } = {}) {
  const file = path.join(ticketDir(config, key), 'history', `${storyShaWanted}.md`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const meta = readMeta(config, key);
  if (!meta?.issue?.number || !boardAvailable(config)) return null;
  try {
    const [owner, name] = config.tickets.repo.split('/');
    const data = ghJson(gh, ['api', 'graphql', '-f', `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){userContentEdits(first:50){nodes{diff}}}}}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${meta.issue.number}`]);
    for (const edit of data.data.repository.issue.userContentEdits.nodes) {
      const parsed = safeParse(edit.diff);
      if (parsed?.content != null && storySha(parsed.content) === storyShaWanted) {
        fs.writeFileSync(file, parsed.content);
        return parsed.content;
      }
    }
  } catch {
    // no edit history available
  }
  return null;
}
