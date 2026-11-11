// Reads the legacy story folder (config.tickets.legacyDir, `product-research/` until it is deleted) and
// classifies every file in it: a ticket (story, bug, epic, research spike), an asset of a ticket
// (mockups, images, attachments), ignored OS clutter, or unplaced. Used by `board migrate` and, while the
// folder still exists, by the loader to import a ticket that is not on the board yet.
import fs from 'node:fs';
import path from 'node:path';
import { blockersOf } from '../../implement/lib/batch.mjs';
import { epicSlugOf } from './board.mjs';
import { sha256 } from './ticket-format.mjs';

const STORY = /^([A-Z][A-Z0-9]*-\d+)-.+\.md$/;
const KEY_PREFIX = /^([A-Z][A-Z0-9]*-\d+)(?:-|$)/;
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const INDEX_DOC = /^(readme|index|template|_template|story-template|.*-template)\.md$/i;

export function legacyRoot(config) {
  const dir = config.tickets?.legacyDir;
  if (!dir) return null;
  const abs = path.join(config.root, dir);
  return fs.existsSync(abs) ? abs : null;
}

export function walkFiles(root) {
  const out = [];
  const visit = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(child);
      else if (e.isFile()) out.push(child);
    }
  };
  visit('');
  return out;
}

const titleOf = (text, fallback) => /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fallback;
export const kebab = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Relative links (images and files) a Markdown text points at, resolved against its folder.
function linkedPaths(text, fromRel) {
  const dir = path.posix.dirname(fromRel);
  const out = new Set();
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\bsrc=["']([^"']+)["']/g)) {
    const raw = (m[1] ?? m[2]).split('#')[0].split('?')[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) continue;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // keep the raw form
    }
    out.add(path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, decoded)));
  }
  return out;
}

export const isBug = (key, text) => key.startsWith('BUG-') || /\*\*Type:\*\*\s*Bug/i.test(text);

// The tickets and assets the legacy folder holds. Returns
// { root, files, tickets, assets, unplaced, ignored }; each ticket has { key, type, title, slug, source,
// parent, blockedBy, text, assets: [{ path, name, kind, source, sha256, size }] }.
export function classifyLegacy(config, root = legacyRoot(config)) {
  const result = { root, files: [], tickets: [], unplaced: [], ignored: [] };
  if (!root) return result;
  const files = walkFiles(root);
  result.files = files;
  const read = (rel) => fs.readFileSync(path.join(root, rel));
  const placed = new Map(); // rel -> ticket key
  const byKey = new Map();
  const add = (t) => {
    byKey.set(t.key, t);
    result.tickets.push(t);
    placed.set(t.source, t.key);
  };
  const attach = (ticket, rel, kind, name) => {
    if (placed.has(rel)) return;
    const data = read(rel);
    const prefix = kind === 'mockup' ? 'mockups' : 'files';
    ticket.assets.push({ path: `${prefix}/${ticket.key}/${name}`, name, kind, source: rel, sha256: sha256(data), size: data.length });
    placed.set(rel, ticket.key);
  };

  // 1. Stories and bugs: stories/<KEY>-<title>.md. A second file for a key is attached to the first.
  for (const rel of files.filter((f) => f.startsWith('stories/') && STORY.test(path.posix.basename(f)) && path.posix.dirname(f) === 'stories')) {
    const name = path.posix.basename(rel);
    const key = STORY.exec(name)[1];
    const text = read(rel).toString('utf8');
    if (byKey.has(key)) continue;
    add({ key, type: isBug(key, text) ? 'bug' : 'story', title: titleOf(text, key), slug: name.slice(0, -3), source: rel, parent: epicSlugOf(text), blockedBy: blockersOf(text, key), text, assets: [] });
  }
  // 2. Epics: epic-<slug>.md anywhere.
  for (const rel of files.filter((f) => /^epic-[\w-]+\.md$/.test(path.posix.basename(f)))) {
    const key = path.posix.basename(rel, '.md');
    if (byKey.has(key)) continue;
    const text = read(rel).toString('utf8');
    const title = titleOf(text, key).replace(/^Epic:\s*/i, '');
    add({ key, type: 'epic', title: `Epic: ${title}`, slug: key, source: rel, parent: null, blockedBy: [], text, assets: [] });
  }
  // 3. Research documents: any other Markdown that is not an index or template becomes a research spike
  //    under the spike epic (a new epic, generated below).
  const spikeEpic = config.tickets.spikeEpic;
  const spikes = [];
  for (const rel of files.filter((f) => f.endsWith('.md') && !placed.has(f) && !f.startsWith('mockups/') && !INDEX_DOC.test(path.posix.basename(f)) && !(f.startsWith('stories/') && path.posix.dirname(f) === 'stories'))) {
    const stem = path.posix.basename(rel, '.md');
    const key = `spike-${kebab(stem).replace(/^spike-/, '')}`;
    if (byKey.has(key)) continue;
    const text = read(rel).toString('utf8');
    const t = { key, type: 'spike', title: `Spike: ${titleOf(text, stem).replace(/^Spike:\s*/i, '')}`, slug: key, source: rel, parent: spikeEpic.key, blockedBy: [], text, assets: [] };
    add(t);
    spikes.push(t);
  }
  if (spikes.length && !byKey.has(spikeEpic.key)) {
    const text = spikeEpicText(spikeEpic.title, spikes);
    const t = { key: spikeEpic.key, type: 'epic', title: `Epic: ${spikeEpic.title}`, slug: spikeEpic.key, source: null, generated: true, parent: null, blockedBy: [], text, assets: [] };
    byKey.set(t.key, t);
    result.tickets.push(t);
  }

  // 4. Mockups: mockups/<owner>-<name>/... belong to the story key or epic slug the folder starts with.
  const ownerOf = (folder) => {
    const key = KEY_PREFIX.exec(folder)?.[1];
    if (key && byKey.has(key)) return byKey.get(key);
    return result.tickets.find((t) => t.type === 'epic' && (folder === t.key || folder.startsWith(`${t.key}-`))) ?? null;
  };
  for (const rel of files.filter((f) => f.startsWith('mockups/') && f.split('/').length > 2)) {
    const [, folder, ...rest] = rel.split('/');
    const owner = ownerOf(folder);
    if (owner) attach(owner, rel, 'mockup', `${folder}/${rest.join('/')}`);
  }
  // 5. Files a ticket's Markdown links to (images in a research write-up, attachments of a story).
  for (const t of result.tickets.filter((x) => x.source)) {
    for (const target of linkedPaths(t.text, t.source)) {
      if (!files.includes(target) || placed.has(target)) continue;
      const base = path.posix.dirname(t.source) === '.' ? '' : `${path.posix.dirname(t.source)}/`;
      attach(t, target, 'file', target.startsWith(base) ? target.slice(base.length) : target);
    }
  }
  // 6. Everything else: OS clutter is ignored; a file in a folder that holds a research spike, or whose
  //    path names a ticket, goes to that ticket; the rest is unplaced and reported.
  for (const rel of files.filter((f) => !placed.has(f))) {
    if (IGNORED.has(path.posix.basename(rel))) {
      result.ignored.push(rel);
      continue;
    }
    const dir = path.posix.dirname(rel);
    const spike = spikes.find((s) => dir !== '.' && (path.posix.dirname(s.source) === dir || rel.startsWith(`${path.posix.dirname(s.source)}/`)) && path.posix.dirname(s.source) !== '.');
    const named = rel.split('/').map((seg) => KEY_PREFIX.exec(seg)?.[1] ?? (/^epic-[\w-]+/.exec(seg)?.[0]?.replace(/\.md$/, '') ?? null)).find((k) => k && byKey.has(k));
    const owner = spike ?? (named ? byKey.get(named) : null) ?? (rel.startsWith('mockups/') ? ownerOf(rel.split('/')[1]) : null);
    if (owner) {
      const base = owner.source && path.posix.dirname(owner.source) !== '.' ? `${path.posix.dirname(owner.source)}/` : '';
      attach(owner, rel, rel.startsWith('mockups/') ? 'mockup' : 'file', rel.startsWith('mockups/') ? rel.slice('mockups/'.length) : rel.startsWith(base) ? rel.slice(base.length) : rel);
    } else {
      result.unplaced.push({ source: rel, reason: reasonFor(rel) });
    }
  }
  for (const t of result.tickets) t.assets.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function reasonFor(rel) {
  if (INDEX_DOC.test(path.posix.basename(rel))) return 'folder index or template: no ticket owns it; move what it says into docs/ai-pipeline/writing-stories.md, or link it from a ticket and re-run';
  if (rel.startsWith('mockups/')) return 'mockup without a folder named after a story key or epic file';
  return 'no ticket links to it and its path names no ticket; link it from a ticket (or move it next to one) and re-run';
}

export function spikeEpicText(title, spikes) {
  return [
    `# Epic: ${title}`,
    '',
    '## Summary',
    '',
    `${title} for eShop. The research behind it is in the research spike(s) below, which are sub-issues of this epic. Stories are added as sub-issues once the work is planned.`,
    '',
    '## Research',
    '',
    ...spikes.map((s) => `- ${s.title.replace(/^Spike:\s*/, '')} (\`${s.key}\`)`),
    '',
  ].join('\n');
}

// One ticket from the legacy folder by key (story key, epic slug or spike key), or null.
export function legacyTicket(config, key) {
  const root = legacyRoot(config);
  if (!root) return null;
  return classifyLegacy(config, root).tickets.find((t) => t.key === key) ?? null;
}

// A stable fingerprint of the folder's contents (every path and its sha256), so `migrate --delete-local`
// can tell whether the files changed since the last verify.
export function folderFingerprint(root, files = walkFiles(root)) {
  return sha256(files.map((f) => `${f}\0${sha256(fs.readFileSync(path.join(root, f)))}`).join('\n'));
}
