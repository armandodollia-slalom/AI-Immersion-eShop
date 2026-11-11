import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allowedModels,
  assertProviderUsable,
  availableModels,
  checkConfigs,
  discoverModels,
  loadPolicy,
  ModelNotAllowedError,
  parseCodexModels,
  parseCopilotHelpConfig,
  ProviderDisabledError,
  resolveModel,
  STATIC_CLAUDE_MODELS,
} from '../lib/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The pipeline config's agent section is the policy (scripts/pipeline/config.json).
const AGENT = {
  cli: 'claude',
  allowedModels: ['opus', 'sonnet'],
  modelIds: { claude: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, copilot: { opus: 'claude-opus-5.5', sonnet: 'claude-sonnet-5.5' } },
  strictModels: true,
  models: { default: 'sonnet' },
};

let n = 0;
function configDir() {
  const dir = path.join(tmp, `cfg-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ cacheTtlHours: 24 }));
  return dir;
}
const base = (agent = AGENT) => ({ configDir: configDir(), pipelineConfig: { agent } });
const cacheFile = () => path.join(tmp, `cache-${n++}.json`);

// A fake command runner: maps "cmd arg arg" to {status, stdout}; anything else is "not installed".
function fakeRunner(table) {
  const calls = [];
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    if (key in table) return { status: 0, stderr: '', error: null, ...table[key] };
    const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    return { status: null, stdout: '', stderr: '', error: err };
  };
  run.calls = calls;
  return run;
}

const COPILOT_HELP = `Configuration Settings:

  \`mouse\`: whatever.
  \`model\`: AI model to use for Copilot CLI, including custom and local models; can be changed with /model command or --model flag option.
    - "claude-sonnet-5.5"
    - "claude-opus-5.5"
    - "claude-haiku-5.5"
    - "gpt-6-sol"

  \`contextTier\`: context window tier.
    - "default"
`;
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: 'gpt-6-sol', visibility: 'list' },
    { slug: 'gpt-5.5', visibility: 'list' },
    { slug: 'codex-auto-review', visibility: 'hide' },
  ],
});

// --- policy ---------------------------------------------------------------------------------------

test('the policy per CLI: agent.allowedModels mapped through agent.modelIds, default from agent.models.default', () => {
  const opts = base();
  assert.deepEqual(allowedModels('claude', opts), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(allowedModels('copilot', opts), ['claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.deepEqual(allowedModels('codex', opts), [], 'no ids for codex: nothing allowed');
  assert.equal(resolveModel('claude', null, opts), 'claude-sonnet-5-5');
  assert.equal(resolveModel('copilot', '', opts), 'claude-sonnet-5.5');
  assert.equal(resolveModel('copilot', 'default', opts), 'claude-sonnet-5.5');
});

test('the checked-in policy allows exactly Opus 5.5 and Sonnet 5.5 and disables codex', () => {
  const opts = { configDir: path.join(here, '..') };
  assert.deepEqual(allowedModels('claude', opts), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(allowedModels('copilot', opts), ['claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.throws(() => assertProviderUsable('codex', opts), ProviderDisabledError);
});

test('an id mapped for an alias outside allowedModels is ignored with a warning', () => {
  const policy = loadPolicy(base({ ...AGENT, modelIds: { ...AGENT.modelIds, claude: { ...AGENT.modelIds.claude, haiku: 'claude-haiku-5-5' } } }));
  assert.deepEqual(policy.providers.claude.allowed, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.match(policy.warnings.join('\n'), /claude: agent.modelIds maps "haiku", which is not in agent.allowedModels/);
});

test('aliases and the CLI\'s own ids resolve, through the same check as every agent run', () => {
  const opts = base();
  assert.equal(resolveModel('claude', 'opus', opts), 'claude-opus-5-5');
  assert.equal(resolveModel('claude', 'claude-sonnet-5-5', opts), 'claude-sonnet-5-5');
  assert.equal(resolveModel('copilot', 'claude-opus-5.5', opts), 'claude-opus-5.5');
  assert.equal(resolveModel('copilot', 'sonnet', opts), 'claude-sonnet-5.5');
  assert.throws(() => resolveModel('claude', 'claude-opus-5.5', opts), ModelNotAllowedError, "another CLI's spelling is not this CLI's id");
});

test('models outside the policy are rejected with the allowed list', () => {
  const opts = base();
  for (const [provider, model] of [['claude', 'claude-haiku-5-5'], ['claude', 'haiku'], ['claude', 'claude-opus-5'], ['copilot', 'auto'], ['copilot', 'gpt-6-sol']]) {
    assert.throws(
      () => resolveModel(provider, model, opts),
      (e) => e instanceof ModelNotAllowedError && e.provider === provider && e.requested === model && e.allowed.length === 2 && /not allowed/.test(e.message),
    );
  }
});

test('codex is disabled: no allowed models configured', () => {
  const opts = base();
  assert.throws(() => assertProviderUsable('codex', opts), (e) => e instanceof ProviderDisabledError && /no allowed models configured for codex/.test(e.message));
  assert.throws(() => resolveModel('codex', null, opts), ProviderDisabledError);
  assert.throws(() => resolveModel('codex', 'gpt-6-sol', opts), ProviderDisabledError);
  assert.equal(assertProviderUsable('claude', opts), true);
  assert.throws(() => resolveModel('gemini', null, opts), /Unknown model provider/);
});

// --- discovery parsing ----------------------------------------------------------------------------

test('parses the model list from copilot help config', () => {
  assert.deepEqual(parseCopilotHelpConfig(COPILOT_HELP), ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-haiku-5.5', 'gpt-6-sol']);
  assert.deepEqual(parseCopilotHelpConfig('nothing here'), []);
});

test('parses codex debug models JSON', () => {
  assert.deepEqual(parseCodexModels(CODEX_JSON), [
    { id: 'gpt-6-sol', hidden: false },
    { id: 'gpt-5.5', hidden: false },
    { id: 'codex-auto-review', hidden: true },
  ]);
  assert.throws(() => parseCodexModels('{"x":1}'), /no models array/);
});

test('copilot discovery runs the CLI and records aliases', async () => {
  const runner = fakeRunner({ 'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.109.\n' }, 'copilot help config': { stdout: COPILOT_HELP } });
  const d = await discoverModels('copilot', { ...base(), runner, cacheFile: cacheFile() });
  assert.equal(d.installed, true);
  assert.equal(d.source, 'cli');
  assert.equal(d.version, 'GitHub Copilot CLI 1.0.109.');
  assert.deepEqual(d.models[0], { id: 'claude-sonnet-5.5', aliases: ['claude-sonnet-5-5'], source: 'cli' });
});

test('codex discovery falls back to the bundled catalog', async () => {
  const runner = fakeRunner({ 'codex --version': { stdout: 'codex-cli 0.167.1\n' }, 'codex debug models': { status: 1, stdout: '' }, 'codex debug models --bundled': { stdout: CODEX_JSON } });
  const d = await discoverModels('codex', { ...base(), runner, cacheFile: cacheFile() });
  assert.equal(d.source, 'bundled');
  assert.deepEqual(d.models.map((m) => m.id), ['gpt-6-sol', 'gpt-5.5', 'codex-auto-review']);
  assert.equal(d.models[2].hidden, true);
});

test('claude discovery uses the static list without an API key', async () => {
  const runner = fakeRunner({ 'claude --version': { stdout: '2.1.318 (Claude Code)\n' } });
  const d = await discoverModels('claude', { ...base(), runner, env: {}, cacheFile: cacheFile(), fetch: () => assert.fail('no API call without a key') });
  assert.equal(d.source, 'static');
  assert.deepEqual(d.models.map((m) => m.id), STATIC_CLAUDE_MODELS);
});

test('claude discovery pages through the models API when a key is configured', async () => {
  const runner = fakeRunner({ 'claude --version': { stdout: '2.1.318 (Claude Code)\n' } });
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers['x-api-key'], 'sk-test');
    const page = urls.length === 1 ? { data: [{ id: 'claude-opus-5-5' }], has_more: true, last_id: 'claude-opus-5-5' } : { data: [{ id: 'claude-sonnet-5-5' }], has_more: false };
    return { ok: true, json: async () => page };
  };
  const d = await discoverModels('claude', { ...base(), runner, env: { ANTHROPIC_API_KEY: 'sk-test' }, fetch, cacheFile: cacheFile() });
  assert.equal(d.source, 'api');
  assert.deepEqual(d.models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.match(urls[1], /after_id=claude-opus-5-5/);
});

test('a missing CLI is reported as not installed and not cached', async () => {
  const file = cacheFile();
  const d = await discoverModels('copilot', { ...base(), runner: fakeRunner({}), cacheFile: file });
  assert.equal(d.installed, false);
  assert.equal(fs.existsSync(file), false);
});

// --- cache ----------------------------------------------------------------------------------------

test('discovery is cached for the TTL and refreshed after it or on --refresh', async () => {
  const file = cacheFile();
  const runner = fakeRunner({ 'copilot --version': { stdout: '1.0\n' }, 'copilot help config': { stdout: COPILOT_HELP } });
  let clock = 1_000_000;
  const opts = { ...base(), runner, cacheFile: file, now: () => clock };
  const first = await discoverModels('copilot', opts);
  assert.equal(first.cached, false);
  assert.equal(runner.calls.length, 2);

  clock += 23 * 3600 * 1000;
  const second = await discoverModels('copilot', opts);
  assert.equal(second.cached, true);
  assert.equal(runner.calls.length, 2);

  const forced = await discoverModels('copilot', { ...opts, refresh: true });
  assert.equal(forced.cached, false);
  assert.equal(runner.calls.length, 4);

  clock += 25 * 3600 * 1000;
  const expired = await discoverModels('copilot', opts);
  assert.equal(expired.cached, false);
  assert.equal(runner.calls.length, 6);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).providers.copilot);
});

// --- availability ---------------------------------------------------------------------------------

test('available models are allowed ∩ discovered', async () => {
  const help = COPILOT_HELP.replace('    - "claude-opus-5.5"\n', '');
  const runner = fakeRunner({ 'copilot --version': { stdout: '1.0\n' }, 'copilot help config': { stdout: help } });
  const a = await availableModels('copilot', { ...base(), runner, cacheFile: cacheFile() });
  assert.deepEqual(a.models, ['claude-sonnet-5.5']);
  assert.equal(a.degraded, false);
  assert.match(a.warning, /not offered by the installed copilot CLI: claude-opus-5.5/);
});

test('static or failed discovery falls back to the allowed list with a warning flag', async () => {
  const opts = { ...base(), env: {}, cacheFile: cacheFile() };
  const fromStatic = await availableModels('claude', { ...opts, runner: fakeRunner({ 'claude --version': { stdout: '2\n' } }) });
  assert.deepEqual(fromStatic.models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(fromStatic.degraded, true);
  assert.match(fromStatic.warning, /static list/);

  const failed = await availableModels('copilot', { ...opts, cacheFile: cacheFile(), runner: fakeRunner({ 'copilot --version': { stdout: '1\n' }, 'copilot help config': { status: 1, stdout: '' } }) });
  assert.deepEqual(failed.models, ['claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.equal(failed.degraded, true);

  const missing = await availableModels('copilot', { ...opts, cacheFile: cacheFile(), runner: fakeRunner({}) });
  assert.equal(missing.degraded, true);
  assert.match(missing.warning, /not installed/);
});

test('codex availability: disabled even when installed', async () => {
  const runner = fakeRunner({ 'codex --version': { stdout: 'codex-cli 0.167.1\n' }, 'codex debug models': { stdout: CODEX_JSON } });
  const a = await availableModels('codex', { ...base(), runner, cacheFile: cacheFile() });
  assert.equal(a.disabled, true);
  assert.deepEqual(a.models, []);
  assert.equal(a.discovery.installed, true);
  assert.match(a.warning, /no allowed models configured for codex/);
});

// --- check ----------------------------------------------------------------------------------------

function fixtureRepo(files) {
  const root = path.join(tmp, `repo-${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('check passes when every configured model is allowed', () => {
  const root = fixtureRepo({
    'scripts/pipeline/config.json': { agent: AGENT },
    'scripts/review/config.json': { agent: { models: { reviewer: 'opus' } } },
    'scripts/implement/config.json': {
      agent: { models: { implementer: 'claude-opus-5-5' } },
      modelClasses: { small: 'sonnet', medium: 'sonnet', large: 'opus' },
      implement: { roles: { verifier: { cli: null, modelClass: 'medium' }, uiVerifier: { cli: 'copilot', modelClass: 'large' } } },
    },
    'scripts/pr-check/config.json': { prCheck: { models: { claude: { judge: 'opus' }, copilot: { judge: 'claude-opus-5.5' }, codex: {} } } },
    '.github/agents/reviewer.agent.md': '---\nname: reviewer\nmodel: sonnet\n---\nbody\n',
    '.github/agents/other.agent.md': '---\nname: other\nmodel: inherit\n---\nbody\n',
  });
  const result = checkConfigs({ root, configDir: configDir() });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  // default + reviewer + implementer + 3 classes x 2 CLIs + 2 pr-check + the agent file for 2 CLIs
  assert.equal(result.checked.length, 1 + 1 + 1 + 6 + 2 + 2);
});

test('check reports models outside the policy and roles on a disabled CLI', () => {
  const root = fixtureRepo({
    'scripts/pipeline/config.json': { agent: { ...AGENT, models: { default: 'haiku' } } },
    'scripts/implement/config.json': {
      modelClasses: { small: 'haiku', medium: 'sonnet', large: 'opus' },
      implement: { roles: { uiVerifier: { cli: 'codex', modelClass: 'large' } } },
    },
    'scripts/qe/config.local.json': { agent: { models: { verifier: 'gpt-6-sol' } } },
    '.github/agents/reviewer.agent.md': '---\nname: reviewer\nmodel: "gpt-6-sol"\n---\n',
    '.claude/agents/x.md': '---\nmodel: haiku\n---\n',
  });
  const result = checkConfigs({ root, configDir: configDir() });
  assert.equal(result.ok, false);
  const where = [...new Set(result.problems.map((p) => `${p.file}:${p.where}`))].sort();
  assert.deepEqual(where, [
    '.claude/agents/x.md:frontmatter model',
    '.github/agents/reviewer.agent.md:frontmatter model',
    'scripts/implement/config.json:implement.roles.uiVerifier.cli',
    'scripts/implement/config.json:modelClasses.large',
    'scripts/implement/config.json:modelClasses.medium',
    'scripts/implement/config.json:modelClasses.small',
    'scripts/pipeline/config.json:agent.models.default',
    'scripts/qe/config.local.json:agent.models.verifier',
  ]);
  assert.match(result.problems.find((p) => p.where === 'implement.roles.uiVerifier.cli').message, /no allowed models configured for codex/);
});

test('check fails when the pipeline CLI itself is disabled', () => {
  const root = fixtureRepo({ 'scripts/pipeline/config.json': { agent: { ...AGENT, cli: 'codex' } } });
  const result = checkConfigs({ root, configDir: configDir() });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].where, 'agent.cli');
});

test('this repository only configures allowed models', () => {
  const result = checkConfigs({ configDir: path.join(here, '..') });
  assert.deepEqual(result.problems, []);
});

test('the models CLI rejects a model outside the policy', () => {
  const resolve = spawnSync(process.execPath, [path.join(here, '..', 'models.mjs'), 'resolve', '--provider', 'claude', '--model', 'haiku'], { encoding: 'utf8' });
  assert.equal(resolve.status, 1);
  assert.match(resolve.stderr, /not allowed for claude/);
});
