// Model selection (agent.allowedModels / modelIds) and the async command runner used to run
// independent test commands side by side.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveModel } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';
import { runAsync } from '../lib/util.mjs';

const base = (cli = 'claude', extra = {}) => ({
  agent: {
    cli,
    cmd: null,
    allowedModels: ['opus', 'sonnet', 'haiku'],
    modelIds: { claude: { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' }, copilot: { sonnet: 'claude-sonnet-5.5' } },
    ...extra,
  },
});

test('resolveModel maps an allowed alias to the CLI id, and null to the CLI default', () => {
  assert.equal(resolveModel(base(), 'sonnet'), 'sonnet');
  assert.equal(resolveModel(base('copilot'), 'sonnet'), 'claude-sonnet-5.5');
  assert.equal(resolveModel(base(), null), null);
});

test('resolveModel rejects models outside agent.allowedModels', () => {
  assert.throws(() => resolveModel(base(), 'gpt-5'), /Model "gpt-5" is not allowed\. Allowed models: opus, sonnet, haiku/);
});

test('resolveModel accepts a CLI id only when an allowed alias maps to it', () => {
  assert.equal(resolveModel(base('copilot'), 'claude-sonnet-5.5'), 'claude-sonnet-5.5');
  assert.throws(() => resolveModel(base('copilot'), 'claude-fable-5.2'), /not allowed/);
  assert.throws(() => resolveModel(base('claude'), 'claude-sonnet-5.5'), /not allowed/, 'an id for another CLI is not allowed');
});

test('every PR-check role model is allowed for its CLI', () => {
  const config = loadConfig('pr-check');
  for (const [cli, roles] of Object.entries(config.prCheck.models)) {
    const forCli = { agent: { ...config.agent, cli, cmd: null } };
    for (const [role, model] of Object.entries(roles)) assert.doesNotThrow(() => resolveModel(forCli, model), `${cli} ${role}: ${model}`);
  }
});

test('resolveModel falls back to the CLI default when the CLI has no id for the alias', () => {
  assert.equal(resolveModel(base('copilot'), 'haiku'), null);
  assert.equal(resolveModel(base('codex'), 'opus'), null);
});

test('resolveModel passes the alias through to a custom agent command', () => {
  assert.equal(resolveModel(base('claude', { cmd: 'my-agent' }), 'haiku'), 'haiku');
});

test('PIPELINE_MODEL_OVERRIDE forces one allowed alias, and is checked too', () => {
  process.env.PIPELINE_MODEL_OVERRIDE = 'haiku';
  try {
    assert.equal(resolveModel(base(), 'opus'), 'haiku');
    process.env.PIPELINE_MODEL_OVERRIDE = 'nope';
    assert.throws(() => resolveModel(base(), 'opus'), /not allowed/);
  } finally {
    delete process.env.PIPELINE_MODEL_OVERRIDE;
  }
});

test('the checked-in configs only use allowed models, and test writing uses sonnet', () => {
  const qe = loadConfig('qe');
  assert.deepEqual(qe.agent.allowedModels, ['opus', 'sonnet', 'sol']);
  assert.equal(qe.agent.models.automation, 'sonnet');
  for (const stage of [null, 'review', 'implement', 'qe']) {
    for (const alias of Object.values(loadConfig(stage).agent.models)) {
      if (alias) assert.ok(qe.agent.allowedModels.includes(alias), alias);
    }
  }
});

test('runAsync runs commands side by side and reports status, output and timeouts', async () => {
  const node = process.execPath;
  const started = Date.now();
  const [a, b] = await Promise.all([
    runAsync(node, ['-e', 'setTimeout(() => { console.log("a"); }, 400)']),
    runAsync(node, ['-e', 'setTimeout(() => { console.error("b"); process.exit(3); }, 400)']),
  ]);
  assert.ok(Date.now() - started < 750, 'ran in parallel');
  assert.deepEqual([a.status, a.stdout.trim()], [0, 'a']);
  assert.deepEqual([b.status, b.stderr.trim()], [3, 'b']);
  const slow = await runAsync(node, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutSec: 0.3 });
  assert.equal(slow.timedOut, true);
  assert.equal((await runAsync('definitely-not-a-command-xyz', [])).status, 127);
});
