import fs from 'node:fs';
import path from 'node:path';

const STORY_FILE = /^([A-Z][A-Z0-9]*-\d+)-.+\.md$/;
const KEY = /\b([A-Z][A-Z0-9]*-\d+)\b/g;

// The keys on a story's "**Blocked by:**" line, e.g. "* **Blocked by:** [PROMO-1](PROMO-1-....md), [PROMO-2](...)".
export function blockersOf(text, key) {
  const line = /^[ \t]*[*-]?[ \t]*\*\*Blocked by:?\*\*:?(.*)$/im.exec(text)?.[1] ?? '';
  return [...new Set([...line.matchAll(KEY)].map((m) => m[1]).filter((k) => k !== key))];
}

const keyOrder = (a, b) => {
  const [pa, na] = a.split(/-(?=\d+$)/);
  const [pb, nb] = b.split(/-(?=\d+$)/);
  return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
};

// A cached board ticket (scripts/pipeline/lib/tickets.mjs): story.md with meta.json next to it.
const ticketMeta = (file) => {
  const meta = path.join(path.dirname(file), 'meta.json');
  if (path.basename(file) !== 'story.md' || !fs.existsSync(meta)) return null;
  return JSON.parse(fs.readFileSync(meta, 'utf8'));
};

// Stories from cached board tickets (their story.md, or the ticket folder), plus Markdown story files
// named <KEY>-<title>.md and directories of them (not recursive). `implement run <KEY>` resolves keys
// to cached tickets first (fetching them from the board).
export function collectStories(inputs, cwd = process.cwd()) {
  const files = [];
  for (const input of inputs) {
    const abs = path.resolve(cwd, input);
    if (!fs.existsSync(abs)) throw new Error(`No such file or directory: ${input}`);
    if (fs.statSync(abs).isDirectory() && fs.existsSync(path.join(abs, 'story.md')) && ticketMeta(path.join(abs, 'story.md'))) {
      files.push(path.join(abs, 'story.md'));
    } else if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) if (STORY_FILE.test(name)) files.push(path.join(abs, name));
    } else if (STORY_FILE.test(path.basename(abs)) || ticketMeta(abs)) {
      files.push(abs);
    } else {
      throw new Error(`${input} is not a story (give a story key, a cached ticket's story.md, or a <KEY>-<title>.md file).`);
    }
  }
  const byKey = new Map();
  for (const file of files) {
    const name = path.basename(file);
    const meta = ticketMeta(file);
    const key = meta?.key ?? STORY_FILE.exec(name)[1];
    if (byKey.has(key) && byKey.get(key).file !== file) throw new Error(`Two story files for ${key}: ${byKey.get(key).file} and ${file}.`);
    const text = fs.readFileSync(file, 'utf8');
    byKey.set(key, {
      key,
      file,
      slug: meta?.slug ?? (meta ? key : name.slice(0, -3)),
      title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? meta?.title ?? key,
      // The cached text is the truth (an edited issue may have new blockers since migration).
      blockedBy: blockersOf(text, key),
      // Implemented: the story has Implementation Notes, or its issue is closed (its PR merged; the
      // notes may never have been published back to the issue).
      implemented: /^##\s+Implementation Notes\b/m.test(text) || String(meta?.issue?.state ?? '').toUpperCase() === 'CLOSED',
      // The issue's labels when the ticket was last fetched (escalation-resolved lets plan() re-run it).
      labels: meta?.issue?.labels ?? [],
    });
  }
  return [...byKey.values()].sort((a, b) => keyOrder(a.key, b.key));
}

// Orders stories so every story comes after the stories in the same batch that block it. Blockers
// outside the batch are left to the implementer, which checks that their code exists.
export function orderStories(stories) {
  const byKey = new Map(stories.map((s) => [s.key, s]));
  for (const s of stories) s.deps = s.blockedBy.filter((k) => byKey.has(k));
  const order = [];
  const mark = new Map();
  const visit = (story, trail) => {
    if (mark.get(story.key) === 'done') return;
    if (mark.get(story.key) === 'visiting') throw new Error(`Dependency cycle between stories: ${[...trail, story.key].join(' -> ')}.`);
    mark.set(story.key, 'visiting');
    for (const dep of story.deps) visit(byKey.get(dep), [...trail, story.key]);
    mark.set(story.key, 'done');
    order.push(story);
  };
  for (const s of stories) visit(s, []);
  return order;
}

export const branchFor = (config, story) => `${config.implement.branchPrefix}${story.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60).replace(/-+$/, '')}`;

export function worktreeFor(config, story) {
  const dir = config.implement.worktreeDir.replace('{repo}', path.basename(config.root));
  return path.resolve(config.root, dir, story.key.toLowerCase());
}
