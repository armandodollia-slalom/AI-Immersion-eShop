#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit): asks this checkout's lspd daemon for the edited file's
// diagnostics and, when there are errors, hands them back to the agent next to the tool result.
// Silent when the file type has no server, no daemon runs, or the server is unavailable or slow: it must never
// get in the way of an edit.
import fs from 'node:fs';
import path from 'node:path';
import { control, daemonPaths, realWorktree, worktreeOf } from './lib/common.mjs';

const EXTENSIONS = new Set(['.cs', '.razor', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sh']);
const MAX_SHOWN = 20;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input || '{}');
  const file = event.tool_input?.file_path;
  if (!file || !EXTENSIONS.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) return;

  const worktree = realWorktree(worktreeOf(path.dirname(file)));
  const timeoutMs = Number(process.env.LSP_HOOK_TIMEOUT_MS ?? 20000);
  const res = await control(daemonPaths(worktree).socket, { lspd: 'diagnostics', files: [path.resolve(file)] }, timeoutMs);
  const diags = Object.values(res.files ?? {})[0];
  if (!Array.isArray(diags)) return; // unavailable: stay quiet
  const errors = diags.filter((d) => d.severity === 'error');
  if (!errors.length) return;
  const rel = path.relative(worktree, file);
  const lines = errors.slice(0, MAX_SHOWN).map((d) => `${rel}:${d.line}:${d.col} ${d.code ?? ''} ${d.message}`.replace(/\s+/g, ' ').trim());
  if (errors.length > MAX_SHOWN) lines.push(`... and ${errors.length - MAX_SHOWN} more`);
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `Language server reports ${errors.length} error(s) in ${rel} after this edit (fix them, or confirm they are expected):\n${lines.join('\n')}`,
    }),
  );
}

main().catch(() => {
  // no daemon, timeout or not a git checkout: nothing to report
});
