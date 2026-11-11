// Adapter for the language-server daemons (scripts/lsp/) that agents reach through MCP tools. The
// harness starts one per worktree, asks it for diagnostics on changed files, and reads the agents' LSP
// call log for metrics. Everything goes through here, so a change in that tooling's contract is a change
// here only. When the tooling is missing or a language server is unavailable, every call degrades to
// "no information" and the run carries on (agents fall back to graphify).
//
// Contract:
//   node scripts/lsp/lspd.mjs start --worktree <path> [--slnf <file>]
//       -> {"ok":true,"pid":n,"socket":"...","csharp":"running|unavailable","reason":"..."} (idempotent)
//   node scripts/lsp/lspd.mjs stop --worktree <path> | status | stop-all
//   node scripts/lsp/lspd.mjs diagnostics --worktree <path> --files <f...>
//       -> {"ok":true,"files":{"<path>":[{"severity","line","col","code","message"}] | "unavailable"}}
//   node scripts/lsp/slnf.mjs --owns <glob> [--owns <glob>...] --out <file.slnf> -> {"ok":true,"projects":[...]}
//   scripts/lsp/setup.sh, run in a new worktree first (dotnet tool restore; npm ci only when needed)
//   `start` also reports csharpState (restoring|starting|loading|ready); a C# server still loading is
//   not a failure, and diagnostics for a language that is not ready come back as {"unavailable": "..."}.
//   MCP tool calls are logged as JSONL {ts, agent, tool, file, symbol} to <worktree git-dir>/lsp/calls.jsonl.
// The commands are `implement.lsp.lspdCmd` and `implement.lsp.slnfCmd` in the config.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { readJsonl, runAsync } from '../../pipeline/lib/util.mjs';

export function gitDir(worktree) {
  const r = git(worktree, ['rev-parse', '--git-dir']);
  return r.status === 0 ? path.resolve(worktree, r.stdout.trim()) : path.join(worktree, '.git');
}

export const callsFile = (worktree) => path.join(gitDir(worktree), 'lsp', 'calls.jsonl');

function lastJson(text) {
  for (const line of String(text).trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // keep looking
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Changed lines that declare a public, internal or protected member with a parameter list (a C#
// method, constructor or delegate signature).
const SIGNATURE = /^[+-](?![+-])\s*(?:\[[^\]]*\]\s*)*(?:public|internal|protected)\b[^=;{]*\(/;
export const signatureChanges = (diff) =>
  String(diff ?? '')
    .split('\n')
    .filter((l) => SIGNATURE.test(l))
    .map((l) => l.slice(1).trim());

const isReferences = (tool) => /referen/i.test(String(tool ?? ''));

export function lspAdapter(config, { mainRoot = INSTALL_ROOT, log = () => {} } = {}) {
  const lsp = config.implement.lsp ?? {};
  const resolve = (cmd, roots) => {
    if (!Array.isArray(cmd) || !cmd.length) return null;
    const [head, ...rest] = cmd;
    const args = rest.map((a) => {
      if (!/[/\\]/.test(a) || path.isAbsolute(a)) return a;
      return roots.map((r) => path.join(r, a)).find((f) => fs.existsSync(f)) ?? null;
    });
    return args.includes(null) ? null : [head, ...args];
  };
  const roots = [mainRoot, config.root];
  const lspd = resolve(lsp.lspdCmd, roots);
  const slnf = resolve(lsp.slnfCmd, roots);
  const setupCmd = (worktree) => resolve(lsp.setupCmd, [worktree, ...roots]);
  const enabled = lsp.enabled !== false && Boolean(lspd);
  const running = new Map(); // worktree -> start result

  const call = async (cmd, args, cwd) => {
    const r = await runAsync(cmd[0], [...cmd.slice(1), ...args], { cwd, timeoutSec: lsp.timeoutSec ?? 300 });
    return { status: r.status, out: lastJson(r.stdout), stderr: r.stderr };
  };

  return {
    enabled,

    // Starts (or reuses) the daemon for a worktree. With `owns`, the C# server loads only the owned
    // projects and what they reference (a solution filter written under the worktree's git dir).
    async start(worktree, { owns = null } = {}) {
      if (!enabled) return { ok: false, csharp: 'unavailable', reason: 'lsp tooling not installed' };
      const setup = setupCmd(worktree);
      if (setup) {
        const r = await call(setup, [], worktree);
        if (r.status !== 0) log(`lsp: setup failed in ${path.basename(worktree)} (exit ${r.status}); starting anyway`);
      }
      let slnfFile = null;
      if (owns?.length && slnf) {
        slnfFile = path.join(gitDir(worktree), 'lsp', 'subtask.slnf');
        fs.mkdirSync(path.dirname(slnfFile), { recursive: true });
        const r = await call(slnf, [...owns.flatMap((g) => ['--owns', g]), '--out', slnfFile], worktree);
        if (!r.out?.ok) {
          log(`lsp: no solution filter for ${worktree} (${r.out?.reason ?? r.stderr.trim().slice(-200) ?? `exit ${r.status}`}); loading the full solution`);
          slnfFile = null;
        }
      }
      const r = await call(lspd, ['start', '--worktree', worktree, ...(slnfFile ? ['--slnf', slnfFile] : [])], worktree);
      const result = r.out?.ok ? r.out : { ok: false, csharp: 'unavailable', reason: r.out?.reason ?? (r.stderr.trim().slice(-300) || `lspd start exited ${r.status}`) };
      if (result.ok) running.set(worktree, result);
      if (result.csharp !== 'running') log(`lsp: C# server unavailable for ${path.basename(worktree)} (${result.reason ?? 'no reason given'}); agents fall back to graphify`);
      return result;
    },

    csharpRunning: (worktree) => running.get(worktree)?.csharp === 'running',

    async stop(worktree) {
      if (!enabled) return false;
      running.delete(worktree);
      const r = await call(lspd, ['stop', '--worktree', worktree], fs.existsSync(worktree) ? worktree : mainRoot);
      return r.status === 0;
    },

    async stopAll() {
      for (const wt of [...running.keys()]) await this.stop(wt);
    },

    // { available, errors: [{file, line, col, code, message}], warnings: [...] } for the given files.
    async diagnostics(worktree, files) {
      const existing = files.filter((f) => fs.existsSync(path.join(worktree, f)));
      if (!enabled || !existing.length) return { available: false, errors: [], warnings: [] };
      const r = await call(lspd, ['diagnostics', '--worktree', worktree, '--files', ...existing], worktree);
      if (!r.out?.ok || !r.out.files) return { available: false, errors: [], warnings: [] };
      const errors = [];
      const warnings = [];
      let available = false;
      for (const [file, list] of Object.entries(r.out.files)) {
        if (!Array.isArray(list)) continue; // "unavailable" for that language
        available = true;
        const rel = path.isAbsolute(file) ? path.relative(worktree, file) : file;
        for (const d of list) {
          const item = { file: rel, line: d.line ?? null, col: d.col ?? null, code: d.code ?? null, message: d.message ?? '' };
          if (String(d.severity).toLowerCase() === 'error' || d.severity === 1) errors.push(item);
          else if (['warning', 2].includes(typeof d.severity === 'string' ? d.severity.toLowerCase() : d.severity)) warnings.push(item);
        }
      }
      return { available, errors, warnings };
    },

    // LSP tool calls an agent made in a worktree between two times (epoch ms).
    calls(worktree, agent, fromMs, toMs = Date.now()) {
      return readJsonl(callsFile(worktree)).filter((c) => (!agent || c.agent === agent) && Date.parse(c.ts) >= fromMs - 1000 && Date.parse(c.ts) <= toMs + 1000);
    },
    isReferences,
  };
}

export function formatDiagnostics(diag, { limit = 40 } = {}) {
  if (!diag?.available) return '(language server diagnostics unavailable)';
  const line = (d, kind) => `- ${kind} ${d.file}${d.line ? `:${d.line}${d.col ? `:${d.col}` : ''}` : ''}${d.code ? ` ${d.code}` : ''}: ${d.message}`;
  const all = [...diag.errors.map((d) => line(d, 'error')), ...diag.warnings.map((d) => line(d, 'warning'))];
  if (!all.length) return 'No errors or warnings in the changed files.';
  return [...all.slice(0, limit), ...(all.length > limit ? [`- ... and ${all.length - limit} more`] : [])].join('\n');
}

export const diagnosticFindings = (diag) =>
  (diag?.errors ?? []).map((d) => ({ severity: 'blocking', source: 'diagnostics', file: d.file, line: d.line, issue: `compiler/analyzer error${d.code ? ` ${d.code}` : ''}: ${d.message}`, fix: 'Fix the error; the harness blocks approval while the changed files have errors.' }));
