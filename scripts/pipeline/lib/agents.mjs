import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveModel } from '../../models/lib/models.mjs';
import { INSTALL_ROOT } from './config.mjs';
import { parseClaudeJson, parseCodexJsonl, parseCopilotUsage, parseUsageFile, readUsageFile, recordUsage } from './usage.mjs';
import { log, parseFrontMatter, run, runAsync, sha } from './util.mjs';

// The checkout being worked on wins; the pipeline's own checkout is the fallback for a worktree whose
// branch predates an agent.
const firstExisting = (config, rel) => [config.root, INSTALL_ROOT].map((r) => path.join(r, rel)).find((f) => fs.existsSync(f)) ?? path.join(config.root, rel);

export function agentDefinition(config, name) {
  const file = firstExisting(config, path.join(config.agentsDir, `${name}.agent.md`));
  const text = fs.readFileSync(file, 'utf8');
  const lessonsFile = firstExisting(config, path.join(config.lessonsDir, `${name}.md`));
  const lessons = fs.existsSync(lessonsFile) ? fs.readFileSync(lessonsFile, 'utf8') : '';
  return { name, body: parseFrontMatter(text).body.trim(), lessons: lessons.trim(), version: sha(`${text}\n${lessons}`, 8) };
}

export function buildPrompt(definition, task) {
  const parts = [definition.body];
  if (definition.lessons) {
    parts.push(`## Lessons from earlier verifier denials (follow these)\n\n${definition.lessons}`);
  }
  parts.push(`## Task\n\n${task}`);
  return parts.join('\n\n');
}

const childEnv = (extra = {}) => ({ ...process.env, PIPELINE_CHILD: '1', ...extra });

// Git commands no headless agent may run: they move branches, rewrite history or touch other worktrees.
const IMPLEMENT_DENY = ['git push', 'git reset', 'git checkout', 'git switch', 'git rebase', 'git worktree'];
const VERIFY_DENY = [...IMPLEMENT_DENY, 'git commit', 'git stash', 'git merge', 'git add', 'git clean', 'git restore'];
const claudeDeny = (cmds) => cmds.map((c) => `Bash(${c}:*)`);

// Language-server tools of the `lsp` MCP server (scripts/lsp/mcp.mjs, see docs/code-intelligence.md).
// Agents that may edit get the whole server; read-only agents get only the tools that change nothing.
export const LSP_SERVER = 'lsp';
export const LSP_MUTATING = ['lsp_rename', 'lsp_code_actions', 'lsp_format_document'];
export const LSP_READ_ONLY = [
  'lsp_goto_definition', 'lsp_goto_type_definition', 'lsp_find_references', 'lsp_find_implementations', 'lsp_hover',
  'lsp_signature_help', 'lsp_document_symbols', 'lsp_workspace_symbols', 'lsp_find_symbol', 'lsp_smart_search',
  'lsp_call_hierarchy', 'lsp_type_hierarchy', 'lsp_diagnostics', 'lsp_workspace_diagnostics', 'lsp_index_files',
  'lsp_completions', 'lsp_document_highlights', 'lsp_inlay_hints', 'lsp_selection_range', 'lsp_folding_ranges',
  'lsp_file_imports', 'lsp_file_exports', 'lsp_related_files', 'lsp_server_status',
];
const claudeLspReadOnly = LSP_READ_ONLY.map((t) => `mcp__${LSP_SERVER}__${t}`);

// Claude Code tool lists per mode. Extend `allowed` here (for example with MCP tools such as
// language servers) to give every agent of that mode the tool.
export const CLAUDE_TOOLS = {
  // The implementation agent commits its own work on its feature branch; it never pushes or moves branches.
  implement: {
    permissionMode: 'acceptEdits',
    allowed: ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'TodoWrite', `mcp__${LSP_SERVER}`],
    disallowed: claudeDeny(IMPLEMENT_DENY),
  },
  write: {
    permissionMode: 'acceptEdits',
    allowed: ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'TodoWrite', `mcp__${LSP_SERVER}`],
    disallowed: claudeDeny(['git push', 'git commit', 'git reset', 'git checkout', 'git stash']),
  },
  verify: {
    allowed: ['Bash', 'Read', 'Glob', 'Grep', ...claudeLspReadOnly],
    disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'Agent', 'Task', ...claudeDeny(VERIFY_DENY)],
  },
  read: {
    allowed: ['Read', 'Glob', 'Grep', 'Bash(graphify:*)', ...claudeLspReadOnly],
    disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
  },
};

// Modes:
//   read       no edits, no shell beyond graphify (reviewers, code verifiers, planning)
//   write      edits and shell, no commits (QE agents)
//   implement  edits, shell and commits on the current branch; no push, reset, checkout, switch, rebase, worktree
//   verify     shell (to run Playwright and take screenshots) but no file edit tools and no git writes
//              (UI verifier); the harness also discards anything it leaves in the working tree
// `noSubagents` forbids the agent from spawning its own subagents (Claude's Agent and Task tools).
// Every invocation also reports token usage (`usage` says where): Claude in its JSON result, Copilot in
// `usageFile`, Codex in its JSON event stream, a custom command by writing PIPELINE_USAGE_FILE (optional).
export function cliInvocation(config, { prompt, mode, model, cli = null, noSubagents = false, cwd = config.root, usageFile = null }) {
  cli = cli || config.agent.cli;
  if (config.agent.cmd) {
    return { cmd: 'sh', args: ['-c', config.agent.cmd], input: prompt, usage: 'file', cli: 'custom', model };
  }
  // The model policy (scripts/models/config.json) decides what may run; it throws before any CLI starts.
  model = resolveModel(cli, model);
  if (cli === 'claude') {
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    const tools = CLAUDE_TOOLS[mode] ?? CLAUDE_TOOLS.read;
    if (tools.permissionMode) args.push('--permission-mode', tools.permissionMode);
    const disallowed = [...tools.disallowed, ...(noSubagents ? ['Agent', 'Task'] : [])];
    args.push('--allowedTools', tools.allowed.join(','), '--disallowedTools', [...new Set(disallowed)].join(','));
    return { cmd: 'claude', args, input: prompt, usage: 'claude', cli, model };
  }
  if (cli === 'copilot') {
    const args = ['-p', prompt, '-s', '--no-color'];
    if (usageFile) args.push('--usage-output-file', usageFile);
    if (model) args.push('--model', model);
    const deny = (cmds) => cmds.flatMap((c) => ['--deny-tool', `shell(${c})`]);
    const lspReadOnly = ['--allow-tool', LSP_SERVER, ...LSP_MUTATING.flatMap((t) => ['--deny-tool', `${LSP_SERVER}(${t})`])];
    // Workspace MCP servers (.mcp.json) load only in a trusted folder; worktrees are new folders.
    // The flag takes no value: it trusts the working directory, which is `cwd`.
    args.push('--trust-folder');
    if (mode === 'implement') {
      args.push('--allow-all-tools', '--allow-tool', LSP_SERVER, ...deny(IMPLEMENT_DENY));
    } else if (mode === 'write') {
      args.push('--allow-all-tools', '--allow-tool', LSP_SERVER, '--deny-tool', 'shell(git push)', '--deny-tool', 'shell(git commit)', '--deny-tool', 'shell(git reset)');
    } else if (mode === 'verify') {
      args.push('--allow-tool', 'shell', '--deny-tool', 'write', ...lspReadOnly, ...deny(VERIFY_DENY));
    } else {
      args.push('--deny-tool', 'write', '--deny-tool', 'shell', ...lspReadOnly);
    }
    return { cmd: 'copilot', args, usage: 'copilot', cli, model };
  }
  if (cli === 'codex') {
    const outFile = path.join(os.tmpdir(), `pipeline-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    // Codex has no per-tool deny list; verify mode needs a shell, so it gets workspace-write and the
    // harness discards whatever it leaves behind.
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', mode === 'read' ? 'read-only' : 'workspace-write', '--output-last-message', outFile];
    // An untrusted worktree ignores .codex/config.toml, so the lsp server is defined inline.
    args.push(
      '-c', `mcp_servers.${LSP_SERVER}.command="node"`,
      '-c', `mcp_servers.${LSP_SERVER}.args=${JSON.stringify([path.join(cwd, 'scripts/lsp/mcp.mjs')])}`,
      '-c', `mcp_servers.${LSP_SERVER}.env_vars=["PIPELINE_AGENT_NAME"]`,
      '-c', `mcp_servers.${LSP_SERVER}.default_tools_approval_mode="approve"`,
    );
    if (mode === 'read' || mode === 'verify') args.push('-c', `mcp_servers.${LSP_SERVER}.disabled_tools=${JSON.stringify(LSP_MUTATING)}`);
    if (model) args.push('-m', model);
    args.push('-');
    return { cmd: 'codex', args, input: prompt, outFile, usage: 'codex', cli, model };
  }
  throw new Error(`Unknown agent CLI "${cli}". Use claude, copilot, codex or set PIPELINE_AGENT_CMD.`);
}

function prepare(config, { name, task, mode, model, cli, noSubagents, cwd, usage }) {
  const definition = agentDefinition(config, name);
  const prompt = buildPrompt(definition, task);
  const alias = model ?? config.agent.models.default ?? null;
  const usageFile = path.join(os.tmpdir(), `pipeline-usage-${process.pid}-${randomUUID()}.json`);
  const invocation = cliInvocation(config, { prompt, mode, model: alias, cli, noSubagents, cwd, usageFile });
  log(`agent ${name} (${mode}, ${config.agent.cmd ? 'custom' : cli || config.agent.cli}, prompt ${definition.version}) started`);
  return { definition, invocation, name, mode, alias, usageFile, usage };
}

// The agent's token usage, from wherever its CLI reported it; Claude's answer is inside its JSON result.
function readUsage({ invocation, name, usageFile }, stdout) {
  const fileText = readUsageFile(usageFile);
  try {
    if (invocation.usage === 'claude') {
      const parsed = parseClaudeJson(stdout);
      return parsed ? { text: parsed.text, models: parsed.models } : { models: [] };
    }
    if (invocation.usage === 'copilot') return { models: fileText ? (parseCopilotUsage(JSON.parse(fileText))?.models ?? []) : [] };
    if (invocation.usage === 'codex') return { models: parseCodexJsonl(stdout, invocation.model)?.models ?? [] };
    return { models: parseUsageFile(fileText)?.models ?? [] };
  } catch (error) {
    log(`could not read token usage of ${name}: ${error.message}`);
    return { models: [] };
  }
}

function finish(config, prepared, result, started) {
  const { definition, invocation, name } = prepared;
  const reported = readUsage(prepared, result.stdout);
  let output = reported.text ?? result.stdout;
  if (invocation.outFile) {
    try {
      output = fs.readFileSync(invocation.outFile, 'utf8');
      fs.unlinkSync(invocation.outFile);
    } catch {
      // fall back to stdout
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  recordUsage(config, {
    ctx: prepared.usage,
    agent: name,
    agentVer: definition.version,
    mode: prepared.mode,
    cli: invocation.cli,
    alias: prepared.alias,
    modelId: invocation.model ?? null,
    models: reported.models,
    seconds,
    ok: result.status === 0,
    timedOut: result.timedOut,
    runId: randomUUID(),
  });
  log(`agent ${name} finished in ${seconds}s (exit ${result.status}${result.timedOut ? ', timed out' : ''})`);
  if (result.status !== 0 && result.stderr.trim()) log(result.stderr.trim().slice(-2000));
  return { ok: result.status === 0, status: result.status, timedOut: result.timedOut, output, version: definition.version, seconds };
}

const spawnOptions = ({ name, mode, usageFile }, cwd, timeoutSec, extraEnv, input) => ({
  cwd,
  input,
  timeoutSec,
  env: childEnv({ PIPELINE_AGENT_NAME: name, PIPELINE_AGENT_MODE: mode, PIPELINE_USAGE_FILE: usageFile, ...extraEnv }),
});

// Every call is a brand-new headless process, so each agent (and each verifier round) starts with a
// clean context containing only the prompt built here. `cli` overrides the configured agent CLI for
// this call (for example a verifier on another provider); PIPELINE_AGENT_CMD still wins.
// `usage` ({ stage, story, round, step }) attributes the run's tokens and cost; see usage.mjs.
export function runAgent(config, { name, task, mode = 'read', model = null, cli = null, noSubagents = false, cwd = config.root, timeoutSec = 900, extraEnv = {}, usage = {} }) {
  const prepared = prepare(config, { name, task, mode, model, cli, noSubagents, cwd, usage });
  const started = Date.now();
  const { invocation } = prepared;
  const result = run(invocation.cmd, invocation.args, spawnOptions(prepared, cwd, timeoutSec, extraEnv, invocation.input));
  return finish(config, prepared, result, started);
}

// Same as runAgent without blocking the event loop, so a harness can run several agents at once.
export async function runAgentAsync(config, { name, task, mode = 'read', model = null, cli = null, noSubagents = false, cwd = config.root, timeoutSec = 900, extraEnv = {}, signal, usage = {} }) {
  const prepared = prepare(config, { name, task, mode, model, cli, noSubagents, cwd, usage });
  const started = Date.now();
  const { invocation } = prepared;
  const result = await runAsync(invocation.cmd, invocation.args, { ...spawnOptions(prepared, cwd, timeoutSec, extraEnv, invocation.input), signal });
  return finish(config, prepared, result, started);
}
