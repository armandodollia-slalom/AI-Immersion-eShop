// How agent CLIs are invoked: modes, subagents, per-call CLI, and the model policy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliInvocation, resolveModel } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';

const config = (cli = 'claude', cmd = null) => ({ agent: { cli, cmd, models: { default: null } } });
const config0 = config;
const flag = (args, name) => args[args.indexOf(name) + 1];

test('the checked-in policy: opus and sonnet only, pinned ids, codex refused, default sonnet', () => {
  const config = loadConfig();
  const forCli = (cli) => ({ agent: { ...config.agent, cli, cmd: null } });
  assert.deepEqual(config.agent.allowedModels, ['opus', 'sonnet']);
  assert.equal(resolveModel(forCli('claude'), 'opus'), 'claude-opus-5-5');
  assert.equal(resolveModel(forCli('claude'), null), 'claude-sonnet-5-5', 'no model: agent.models.default under strictModels');
  assert.equal(resolveModel(forCli('copilot'), 'sonnet'), 'claude-sonnet-5.5');
  assert.equal(resolveModel(forCli('copilot'), 'claude-opus-5.5'), 'claude-opus-5.5', 'a CLI id an allowed alias maps to');
  assert.throws(() => resolveModel(forCli('claude'), 'haiku'), /not allowed/);
  assert.throws(() => resolveModel(forCli('copilot'), 'auto'), /not allowed/);
  assert.throws(() => resolveModel(forCli('codex'), 'sonnet'), /no id for agent CLI "codex"/);
  assert.throws(() => resolveModel(forCli('claude'), 'opus', 'codex'), /codex/, 'a per-call CLI is checked too');
  assert.deepEqual(cliInvocation(config0('claude', 'my-agent'), { prompt: 'p', mode: 'read', model: 'anything' }).args, ['-c', 'my-agent'], 'a custom command picks its own model');
});

test('claude modes: implement and read can forbid subagents; verify has a shell but no edits', () => {
  const impl = cliInvocation(config(), { prompt: 'p', mode: 'implement', model: null, noSubagents: true }).args;
  assert.match(flag(impl, '--disallowedTools'), /Bash\(git push:\*\).*Bash\(git worktree:\*\),Agent,Task$/);
  assert.doesNotMatch(flag(cliInvocation(config(), { prompt: 'p', mode: 'implement', model: null }).args, '--disallowedTools'), /Agent/);
  assert.match(flag(impl, '--allowedTools'), /,mcp__lsp$/, 'implementers get the whole lsp server');
  const verify = cliInvocation(config(), { prompt: 'p', mode: 'verify', model: null }).args;
  assert.match(flag(verify, '--allowedTools'), /^Bash,Read,Glob,Grep,mcp__lsp__lsp_goto_definition,.*mcp__lsp__lsp_find_references/);
  const read = flag(cliInvocation(config(), { prompt: 'p', mode: 'read', model: null }).args, '--allowedTools');
  assert.match(read, /mcp__lsp__lsp_diagnostics/);
  assert.doesNotMatch(read, /lsp_rename|lsp_code_actions|lsp_format_document|mcp__lsp,|mcp__lsp$/, 'read-only agents never get mutating lsp tools');
  assert.match(flag(verify, '--disallowedTools'), /^Edit,Write,.*Agent,Task,.*Bash\(git commit:\*\)/);
  assert.ok(!verify.includes('--permission-mode'));
  const copilot = cliInvocation(config('copilot'), { prompt: 'p', mode: 'verify', model: 'claude-opus-5.5', cwd: '/repo/wt' }).args;
  assert.deepEqual(copilot.slice(copilot.indexOf('--allow-tool'), copilot.indexOf('--allow-tool') + 4), ['--allow-tool', 'shell', '--deny-tool', 'write']);
  assert.ok(copilot.includes('lsp(lsp_rename)'));
  assert.ok(copilot.includes('--trust-folder'), 'worktrees are trusted so .mcp.json loads');
  assert.equal(copilot[copilot.indexOf('--trust-folder') + 1]?.startsWith('--'), true, '--trust-folder takes no value');
});

test('codex gets the lsp server inline (untrusted worktrees), read-only modes without mutating tools', () => {
  const codexConfig = { agent: { cli: 'codex', cmd: null, models: {} } };
  // cliInvocation builds the command for an already-resolved model; the policy (resolveModel) refuses codex today.
  const args = (mode) => cliInvocation(codexConfig, { prompt: 'p', mode, model: null, cwd: '/repo/wt' }).args;
  assert.ok(args('read').includes('mcp_servers.lsp.args=["/repo/wt/scripts/lsp/mcp.mjs"]'));
  assert.ok(args('read').some((a) => a.startsWith('mcp_servers.lsp.disabled_tools=')));
  assert.ok(!args('implement').some((a) => a.startsWith('mcp_servers.lsp.disabled_tools=')));
});
