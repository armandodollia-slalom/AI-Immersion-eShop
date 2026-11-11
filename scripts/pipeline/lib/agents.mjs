import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_ROOT } from './config.mjs';
import { parseClaudeJson, parseCodexJsonl, parseCopilotUsage, parseUsageFile, readUsageFile, recordUsage, summarizeUsage } from './usage.mjs';
import { log, parseFrontMatter, run, sha } from './util.mjs';

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
    parts.push(`## Lessons from earlier reviews, verifier denials and test failures (follow these)\n\n${definition.lessons}`);
  }
  parts.push(`## Task\n\n${task}`);
  return parts.join('\n\n');
}

const childEnv = (extra = {}) => ({ ...process.env, PIPELINE_CHILD: '1', ...extra });

// Git commands no headless agent may run: they move branches, rewrite history or touch other worktrees.
const IMPLEMENT_DENY = ['git push', 'git reset', 'git stash', 'git checkout', 'git switch', 'git rebase', 'git worktree'];
const VERIFY_DENY = [...IMPLEMENT_DENY, 'git commit', 'git merge', 'git add', 'git clean', 'git restore'];
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

// Modes (the model is already resolved to the CLI's own id by resolveModel):
//   read       no edits, no shell beyond graphify (reviewers, code verifiers, planning)
//   write      edits and shell, no commits (QE agents)
//   implement  edits, shell and commits on the current branch; no push, reset, stash, checkout, switch, rebase, worktree
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

// Models are named by alias from agent.allowedModels (opus, sonnet), so one config works for every
// CLI; agent.modelIds maps each alias to that CLI's own id. A stage may also pass a CLI id directly,
// but only one that an allowed alias maps to. null means agent.models.default, else the CLI's default
// model. With agent.strictModels a CLI without an id for the alias is refused instead of falling back
// to its own default model, so nothing outside the allowed list ever runs (Codex has no ids: refused).
// PIPELINE_MODEL_OVERRIDE forces one alias for every agent (for experiments). `cli` overrides the
// configured agent CLI (a role on another provider).
export function resolveModel(config, requested, cli = config.agent.cli) {
  const strict = Boolean(config.agent.strictModels);
  const chosen = process.env.PIPELINE_MODEL_OVERRIDE || requested || (strict ? config.agent.models?.default : null) || null;
  if (!chosen) return null;
  const allowed = config.agent.allowedModels ?? [];
  const ids = config.agent.modelIds?.[cli] ?? {};
  if (!allowed.includes(chosen)) {
    if (allowed.some((alias) => ids[alias] === chosen)) return chosen;
    throw new Error(`Model "${chosen}" is not allowed. Allowed models: ${allowed.join(', ') || '(none)'} (agent.allowedModels in scripts/pipeline/config.json).`);
  }
  if (config.agent.cmd) return chosen;
  if (!ids[chosen]) {
    if (strict) {
      throw new Error(`Model "${chosen}" has no id for agent CLI "${cli}" (agent.modelIds in scripts/pipeline/config.json), and agent.strictModels forbids falling back to the CLI's default model. Add the id or use another agent CLI.`);
    }
    log(`no ${chosen} model id for agent CLI "${cli}" (agent.modelIds); using its default model`);
    return null;
  }
  return ids[chosen];
}

// Reads the agent's answer and token usage once its process has exited, and records the usage.
// Returns the answer and a summary of the recorded usage (tokens, cost, premium requests).
function finishRun(config, invocation, { name, mode, alias, modelId, usageFile, usage, version, stdout, status, timedOut, started }) {
  let output = stdout;
  let models = [];
  if (invocation.outFile) {
    try {
      output = fs.readFileSync(invocation.outFile, 'utf8');
      fs.unlinkSync(invocation.outFile);
    } catch {
      // fall back to stdout
    }
  }
  const fileText = readUsageFile(usageFile);
  try {
    if (invocation.usage === 'claude') {
      const parsed = parseClaudeJson(stdout);
      if (parsed) {
        output = parsed.text;
        models = parsed.models;
      }
    } else if (invocation.usage === 'copilot') {
      models = fileText ? parseCopilotUsage(JSON.parse(fileText))?.models ?? [] : [];
    } else if (invocation.usage === 'codex') {
      models = parseCodexJsonl(stdout, modelId)?.models ?? [];
    } else {
      models = parseUsageFile(fileText)?.models ?? [];
    }
  } catch (error) {
    log(`could not read token usage of ${name}: ${error.message}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const records = recordUsage(config, {
    ctx: usage,
    agent: name,
    agentVer: version,
    mode,
    cli: invocation.cli,
    alias,
    modelId,
    models,
    seconds,
    ok: status === 0,
    timedOut,
    runId: randomUUID(),
  });
  return { output, seconds, usage: summarizeUsage(records) };
}

const usageFileFor = () => path.join(os.tmpdir(), `pipeline-usage-${process.pid}-${randomUUID()}.json`);

function prepare(config, { name, task, mode, model, cli, noSubagents, cwd, promptFile }) {
  const definition = agentDefinition(config, name);
  cli = cli || config.agent.cli;
  let prompt = buildPrompt(definition, task);
  // Copilot takes its prompt as a command-line argument (capped at 32K chars on Windows, and cmd.exe
  // mangles newlines), so its prompt is written to a file and the agent is told to read it.
  if (promptFile !== false && !config.agent.cmd && cli === 'copilot') {
    const file = promptFile ?? path.join(config.root, config.stateDir, 'prompts', `${name}-${process.pid}-${Date.now()}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prompt);
    prompt = `Read the file ${path.relative(cwd, file).replace(/\\/g, '/')} and follow the instructions in it exactly; it is your complete task.`;
  }
  const alias = process.env.PIPELINE_MODEL_OVERRIDE || model || config.agent.models?.default || null;
  // The one model check: throws before any CLI starts when the model is not allowed for this CLI.
  const modelId = resolveModel(config, alias, cli);
  const usageFile = usageFileFor();
  const invocation = cliInvocation(config, { prompt, mode, model: modelId, cli, noSubagents, cwd, usageFile });
  log(`agent ${name} (${mode}, ${invocation.cli}${alias ? `, ${alias}` : ''}, prompt ${definition.version}) started`);
  return { definition, invocation, alias, modelId, usageFile };
}

const finalize = (config, prepared, { name, mode, usage }, { stdout, stderr, status, timedOut }, started) => {
  const { definition, invocation, alias, modelId, usageFile } = prepared;
  const { output, seconds, usage: used } = finishRun(config, invocation, { name, mode, alias, modelId, usageFile, usage, version: definition.version, stdout, status, timedOut, started });
  log(`agent ${name} finished in ${seconds}s (exit ${status}${timedOut ? ', timed out' : ''})`);
  if (status !== 0 && stderr.trim()) log(stderr.trim().slice(-2000));
  return { ok: status === 0, status, timedOut, output, version: definition.version, seconds, usage: used };
};

// Every call is a brand-new headless process, so each agent (and each verifier round) starts with a
// clean context containing only the prompt built here. `cli` overrides the configured agent CLI for
// this call (for example a verifier on another provider); PIPELINE_AGENT_CMD still wins.
// `usage` ({ stage, story, round, step }) attributes the run's tokens and cost; see usage.mjs. The
// result's `usage` sums what was recorded ({ tokens, costUsd, premiumRequests, ... }).
export function runAgent(config, { name, task, mode = 'read', model = null, cli = null, noSubagents = false, cwd = config.root, timeoutSec = 900, extraEnv = {}, usage = {} }) {
  const prepared = prepare(config, { name, task, mode, model, cli, noSubagents, cwd, promptFile: false });
  const { invocation, usageFile } = prepared;
  const started = Date.now();
  const result = run(invocation.cmd, invocation.args, {
    cwd,
    input: invocation.input,
    timeoutSec,
    env: childEnv({ PIPELINE_AGENT_NAME: name, PIPELINE_AGENT_MODE: mode, PIPELINE_USAGE_FILE: usageFile, ...extraEnv }),
  });
  return finalize(config, prepared, { name, mode, usage }, result, started);
}

// Non-blocking variant of runAgent, so a stage or the implement harness can run several fresh agents in
// parallel. `signal` (an AbortSignal) kills the agent; on Windows a Copilot prompt goes through
// `promptFile` (see prepare).
export function runAgentAsync(config, { name, task, mode = 'read', model = null, cli = null, noSubagents = false, cwd = config.root, timeoutSec = 900, extraEnv = {}, promptFile = null, signal, usage = {} }) {
  let prepared;
  try {
    prepared = prepare(config, { name, task, mode, model, cli, noSubagents, cwd, promptFile });
  } catch (error) {
    return Promise.reject(error);
  }
  const { invocation, usageFile } = prepared;
  const env = childEnv({ PIPELINE_AGENT_NAME: name, PIPELINE_AGENT_MODE: mode, PIPELINE_USAGE_FILE: usageFile, ...extraEnv });
  // On Windows, npm-installed CLIs are .cmd shims that only start through a shell.
  const useShell = process.platform === 'win32' && !config.agent.cmd;
  const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = useShell
      ? spawn([invocation.cmd, ...invocation.args].map(quote).join(' '), { cwd, shell: true, env })
      : spawn(invocation.cmd, invocation.args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const kill = () => {
      // Through a shell the agent is a grandchild that holds the output pipes open, so kill the whole
      // tree and stop waiting on the pipes.
      if (useShell) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    if (signal?.aborted) kill();
    else signal?.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.input ?? '');
    const done = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve(finalize(config, prepared, { name, mode, usage }, { stdout, stderr: stderr + extra, status: code, timedOut }, started));
    };
    child.on('error', (error) => done(127, `\n${error.message}`));
    child.on('close', (code) => done(code ?? 1));
  });
}
