// Git operations of the implement stage: commits made by the runner (hooks disabled), and the subtask
// worktrees the orchestrated flow branches off a story's worktree.
import fs from 'node:fs';
import path from 'node:path';
import { git, revExists } from '../../pipeline/lib/git.mjs';

export const commitEnv = { ...process.env, PIPELINE_DISABLE: '1' };
export const mustGit = (cwd, args) => git(cwd, args, { allowFail: false, env: commitEnv });

export function commitAll(cwd, message, specs = ['.', ':!graphify-out']) {
  git(cwd, ['add', '-A', '--', ...specs], { env: commitEnv });
  if (git(cwd, ['diff', '--cached', '--quiet']).status === 0) return false;
  mustGit(cwd, ['commit', '-q', '-m', message]);
  return true;
}

export const headSha = (cwd) => git(cwd, ['rev-parse', 'HEAD']).stdout.trim();

export function filesChanged(cwd, base, to = 'HEAD') {
  const r = git(cwd, ['diff', '--name-only', base, to]);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

export function diffSince(cwd, base, maxChars = 150_000) {
  const stat = git(cwd, ['diff', '--stat', base, 'HEAD']).stdout;
  let diff = git(cwd, ['diff', '--no-ext-diff', base, 'HEAD', '--', '.', ':(exclude)graphify-out']).stdout;
  if (diff.length > maxChars) diff = `${diff.slice(0, maxChars)}\n... diff truncated at ${maxChars} chars; read the remaining files directly.`;
  return `Base commit: ${base}\n\n${stat}\n${diff}`;
}

// Throws away whatever an agent that must not edit left in a worktree. Returns the paths it removed.
export function discardChanges(cwd) {
  const dirty = git(cwd, ['status', '--porcelain']).stdout.split('\n').filter(Boolean);
  if (!dirty.length) return [];
  git(cwd, ['reset', '-q', '--hard', 'HEAD'], { env: commitEnv });
  git(cwd, ['clean', '-fdq'], { env: commitEnv });
  return dirty.map((l) => l.slice(3));
}

export const unmergedFiles = (cwd) => git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
export const mergeInProgress = (cwd) => git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;

// ---------------------------------------------------------------------------------------------
// Subtask worktrees: <story worktree>--<id> on <branchPrefix><key>--<id>
// ---------------------------------------------------------------------------------------------

export const subtaskBranch = (prefix, key, id) => `${prefix}${key.toLowerCase()}--${id}`;
export const subtaskWorktree = (storyWorktree, id) => `${storyWorktree}--${id}`;

export function removeWorktree(root, worktree, branch) {
  if (fs.existsSync(worktree)) git(root, ['worktree', 'remove', '--force', worktree], { env: commitEnv });
  if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  git(root, ['worktree', 'prune'], { env: commitEnv });
  if (branch && revExists(root, `refs/heads/${branch}`)) git(root, ['branch', '-D', branch], { env: commitEnv });
}

// A fresh worktree and branch for a subtask, from the story branch's current HEAD. A leftover from an
// earlier run (kept for debugging) is replaced. The story worktree's knowledge graph is copied in, so the
// agents can query it without rebuilding.
export function createSubtaskWorktree(storyWorktree, { prefix, key, id }) {
  const branch = subtaskBranch(prefix, key, id);
  const worktree = subtaskWorktree(storyWorktree, id);
  removeWorktree(storyWorktree, worktree, branch);
  const base = headSha(storyWorktree);
  mustGit(storyWorktree, ['worktree', 'add', '-q', '-b', branch, worktree, base]);
  const graph = path.join(storyWorktree, 'graphify-out');
  for (const f of ['graph.json', 'GRAPH_REPORT.md']) {
    const src = path.join(graph, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(worktree, 'graphify-out'), { recursive: true });
    fs.copyFileSync(src, path.join(worktree, 'graphify-out', f));
  }
  return { branch, path: worktree, base };
}

// Subtask worktrees of a story (or of every story) that are still registered with git.
export function listSubtaskWorktrees(root, prefix, key = null) {
  const out = [];
  let current = null;
  for (const line of git(root, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9) };
    else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice(18);
      const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z][a-z0-9]*-\\d+)--([a-z0-9-]+)$`).exec(current.branch);
      if (m && (!key || m[1] === key.toLowerCase())) out.push({ ...current, key: m[1].toUpperCase(), id: m[2] });
    }
  }
  return out;
}
