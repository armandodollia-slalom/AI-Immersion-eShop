// Story guard (PreToolUse): agents stay out of the ticket cache (.agent-state/board/, and the legacy
// story folder while it exists; config.storyGuard.folders) except for what was handed to the pipeline:
// the active story's cache folder (`pipeline start`: its story.md and its own mockups) and the tickets
// given to `pipeline implement run` (PIPELINE_STORY_SOURCES: cache folders or ticket keys, inherited by
// every agent it starts).
import fs from 'node:fs';
import path from 'node:path';
import { activeStoryFile } from './stories.mjs';

const TICKET_KEY = /^([A-Z][A-Z0-9]*-\d+|(?:epic|spike)-[\w-]+)$/;

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'absolute_path', 'dir_path', 'directory', 'glob'];
const isSearch = (tool) => /grep|search/i.test(tool ?? '');
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// The fixed part of a glob, e.g. .agent-state/board/*/story.md -> .agent-state/board.
const staticPrefix = (p) => p.split(/[*?[{]/)[0].replace(/\/+$/, '') || '.';

const cacheOf = (config) => (config.tickets?.dir ?? '.agent-state/board').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// The ticket a path points into, in any checkout's ticket cache (this one, the main checkout, a story or
// subtask worktree): the key, '' for the cache folder itself, or null when the path is not in a cache.
export function ticketOf(p, cache) {
  const parts = p.split(/[\\/]+/);
  const c = cache.split('/');
  for (let i = 0; i + c.length <= parts.length; i++) if (c.every((seg, j) => parts[i + j] === seg)) return parts[i + c.length] ?? '';
  return null;
}

// What was handed to the pipeline: ticket keys (a key, or a ticket folder in any checkout's cache; both
// mean that ticket wherever it is cached, so a worktree's copy of a handed ticket opens too) and other
// folders or files (legacy story files).
export function handedSources(config, env = process.env) {
  const cache = cacheOf(config);
  const keys = new Set();
  const dirs = [];
  const add = (p) => {
    if (TICKET_KEY.test(p)) return keys.add(p);
    const abs = path.resolve(config.root, p);
    const key = ticketOf(abs, cache);
    if (key && TICKET_KEY.test(key)) keys.add(key);
    else dirs.push(abs);
  };
  for (const p of (env.PIPELINE_STORY_SOURCES ?? '').split(path.delimiter).filter(Boolean)) add(p);
  const active = activeStoryFile(config);
  if (active) add(path.dirname(config.abs(active)));
  return { keys, dirs };
}

// Folders the agents may use: every handed ticket's folder in this checkout's cache, plus other handed paths.
export function allowedSources(config, env = process.env) {
  const { keys, dirs } = handedSources(config, env);
  return [...[...keys].map((k) => path.join(config.root, cacheOf(config), k)), ...dirs];
}

// Paths a tool call touches, resolved against cwd. Shell commands contribute every token that names a
// guarded folder; anything else in a command is not a story path.
export function touchedPaths(payload, folders) {
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd || process.cwd();
  const raw = [];
  for (const key of PATH_KEYS) if (typeof input[key] === 'string') raw.push(input[key]);
  for (const key of ['paths', 'file_paths']) if (Array.isArray(input[key])) raw.push(...input[key].filter((p) => typeof p === 'string'));
  if (typeof input.pattern === 'string' && !isSearch(payload.tool_name)) raw.push(input.pattern);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (typeof e?.file_path === 'string') raw.push(e.file_path);
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : null;
  if (command) {
    const names = folders.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    for (const m of command.matchAll(new RegExp(`[^\\s'"\`;|&<>()]*(?:${names})[^\\s'"\`;|&<>()]*`, 'g'))) raw.push(m[0]);
  }
  return raw.map((p) => path.resolve(cwd, staticPrefix(p.replace(/^~(?=\/)/, process.env.HOME ?? '~'))));
}

// Returns a denial reason, or null when the call may proceed. A path in a ticket cache (of any checkout)
// is allowed only inside a handed ticket's folder: its story and its own mockups (and for an epic run the
// epic's). The path and, when it exists, its real path must both pass, so a symlink cannot reach another
// ticket.
export function storyGuard(config, payload, env = process.env) {
  const folders = config.storyGuard?.folders ?? [];
  if (config.storyGuard?.enabled === false || !folders.length) return null;
  const cache = cacheOf(config);
  const cacheGuarded = folders.some((f) => f.replace(/\/+$/, '').replace(/^\.\//, '') === cache);
  const guarded = folders.map((f) => config.abs(f));
  const { keys, dirs } = handedSources(config, env);
  const offLimits = (q) => {
    const key = cacheGuarded ? ticketOf(q, cache) : null;
    if (key !== null) return !keys.has(key);
    return guarded.some((g) => inside(q, g)) && !dirs.some((a) => inside(q, a));
  };
  const blocked = touchedPaths(payload, folders).filter((p) => offLimits(p) || (fs.existsSync(p) && offLimits(fs.realpathSync(p))));
  if (!blocked.length) return null;
  const allowed = allowedSources(config, env);
  const rel = [...new Set(blocked.map((p) => path.relative(config.root, p) || '.'))].join(', ');
  const scope = allowed.length ? ` Only ${allowed.map((a) => path.relative(config.root, a) || '.').join(', ')} may be used.` : ' No story was handed to the pipeline.';
  return `Story guard: ${rel} is off limits. Agents do not read, search or edit the ticket cache or story folders (${folders.join(', ')}) except for the tickets handed to the pipeline (\`pipeline start <KEY>\` or \`pipeline implement run <KEY...>\`).${scope}`;
}

export const denyOutput = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});
