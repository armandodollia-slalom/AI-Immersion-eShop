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
// The fixed part of a glob, e.g. product-research/stories/*.md -> product-research/stories.
const staticPrefix = (p) => p.split(/[*?[{]/)[0].replace(/\/+$/, '') || '.';

export function allowedSources(config, env = process.env) {
  const cache = config.tickets?.dir ?? '.agent-state/board';
  const allowed = (env.PIPELINE_STORY_SOURCES ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((p) => (TICKET_KEY.test(p) ? path.join(config.root, cache, p) : path.resolve(config.root, p)));
  const active = activeStoryFile(config);
  if (active) allowed.push(path.dirname(config.abs(active)));
  return allowed;
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

// Returns a denial reason, or null when the call may proceed.
export function storyGuard(config, payload, env = process.env) {
  const folders = config.storyGuard?.folders ?? [];
  if (config.storyGuard?.enabled === false || !folders.length) return null;
  const guarded = folders.map((f) => config.abs(f));
  const allowed = allowedSources(config, env);
  const blocked = touchedPaths(payload, folders).filter((p) => {
    const real = fs.existsSync(p) ? fs.realpathSync(p) : p;
    return guarded.some((g) => inside(real, g) || inside(p, g)) && !allowed.some((a) => inside(p, a) || inside(real, a));
  });
  if (!blocked.length) return null;
  const rel = [...new Set(blocked.map((p) => path.relative(config.root, p) || '.'))].join(', ');
  const scope = allowed.length ? ` Only ${allowed.map((a) => path.relative(config.root, a) || '.').join(', ')} may be used.` : ' No story was handed to the pipeline.';
  return `Story guard: ${rel} is off limits. Agents do not read, search or edit the ticket cache or story folders (${folders.join(', ')}) except for the tickets handed to the pipeline (\`pipeline start <KEY>\` or \`pipeline implement run <KEY...>\`).${scope}`;
}

export const denyOutput = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});
