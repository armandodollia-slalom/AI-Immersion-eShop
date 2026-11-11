// Token usage capture, pricing and the cost reports (ticket, epic, overview).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';
import { epicReport, formatStory, overviewReport, storyReport } from '../lib/costs.mjs';
import { costOf, loadUsage, normalizeModel, parseClaudeJson, parseCodexJsonl, parseCopilotUsage, priceFor, usageRecords } from '../lib/usage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const pricing = {
  models: {
    'claude-sonnet-5.5': [
      { effective: null, input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
      { effective: '2026-10-07', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
    ],
    'claude-haiku-5.5': [{ effective: null, input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, longContext: { aboveInputTokens: 100000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } }],
  },
};
const usage = (model, fields = {}) => ({ model, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: null, ...fields });

describe('usage parsing', () => {
  it('normalizes CLI model ids to pricing keys', () => {
    assert.equal(normalizeModel('claude-haiku-5-5'), 'claude-haiku-5.5');
    assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
    assert.equal(normalizeModel('claude-opus-5.5'), 'claude-opus-5.5');
  });

  it('reads the answer and per-model usage from claude --output-format json', () => {
    const out = JSON.stringify({ type: 'result', result: 'pong', modelUsage: { 'claude-haiku-5-5': { inputTokens: 1174, outputTokens: 18, cacheReadInputTokens: 11873, cacheCreationInputTokens: 15500, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 15500, costUSD: 0.00334513 } } });
    const parsed = parseClaudeJson(out);
    assert.equal(parsed.text, 'pong');
    assert.deepEqual([parsed.models[0].input, parsed.models[0].cacheRead, parsed.models[0].cacheWrite5m, parsed.models[0].cacheWrite1h], [1174, 11873, 0, 15500]);
    // pricing.json reproduces Claude's own list-price cost
    assert.equal(costOf(pricing, { ...parsed.models[0], model: normalizeModel(parsed.models[0].model) }, '2026-07-01T00:00:00Z').usd, 0.003345);
    assert.equal(parseClaudeJson('plain text answer'), null);
  });

  it('separates cached tokens from input in Copilot and Codex usage', () => {
    const copilot = parseCopilotUsage({ modelMetrics: { 'claude-haiku-5.5': { usage: { inputTokens: 27449, outputTokens: 4, cacheReadTokens: 19360, cacheWriteTokens: 8085 }, requests: { count: 1, cost: 1 }, totalNanoAiu: 1200 } } });
    assert.deepEqual([copilot.models[0].input, copilot.models[0].cacheRead, copilot.models[0].cacheWrite5m, copilot.models[0].premiumRequests], [4, 19360, 8085, 1]);
    const codex = parseCodexJsonl(['{"type":"thread.started"}', '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50}}'].join('\n'), 'gpt-5.5');
    assert.deepEqual([codex.models[0].input, codex.models[0].cacheRead, codex.models[0].output, codex.models[0].requests], [200, 800, 50, 1]);
  });
});

describe('pricing', () => {
  it('uses the price in effect on the day of use', () => {
    assert.equal(priceFor(pricing, 'claude-sonnet-5.5', '2026-10-06T23:00:00Z').cacheRead, 0.2);
    assert.equal(priceFor(pricing, 'claude-sonnet-5.5', '2026-10-07T00:00:00Z').cacheRead, 0.1);
    assert.equal(priceFor(pricing, 'gpt-unknown', '2026-10-07T00:00:00Z'), null);
  });

  it('applies the long-context tier by average prompt per request', () => {
    const big = usage('claude-haiku-5.5', { input: 150000, output: 1000 });
    assert.equal(costOf(pricing, big, '2026-07-01').pricing.tier, 'long-context');
    assert.equal(costOf(pricing, big, '2026-07-01').usd, (150000 * 0.5 + 1000 * 2.5) / 1e6);
    assert.equal(costOf(pricing, { ...big, requests: 3 }, '2026-07-01').pricing.tier, 'standard');
  });
});

describe('cost reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'costs-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'product-research/stories'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/pipeline/pricing.json'), JSON.stringify(pricing));
  fs.writeFileSync(path.join(root, 'product-research/epic-demo.md'), '# Epic: Demo\n\n### DEMO-1: a\n### DEMO-2: b\n');
  const config = { ...loadConfig(null, ROOT), root, metricsDir: '.agent-metrics' };
  const row = (story, stage, runId, models, ts = '2026-07-01T00:00:00Z') => usageRecords(config, { ctx: { story, stage }, agent: 'x', mode: 'headless', cli: 'claude', runId, models, ts });
  const rows = [
    ...row('DEMO-1', 'implement', 'r1', [usage('claude-sonnet-5.5', { input: 1e6, cacheRead: 1e6 }), usage('claude-haiku-5.5', { output: 1e6 })]),
    ...row('DEMO-1', 'review', 'r2', [usage('claude-sonnet-5.5', { output: 1e5 })]),
    ...row('DEMO-1', 'review', 'r3', []),
    ...row('DEMO-2', 'implement', 'r4', [usage('mystery-model', { input: 500 })], '2026-08-01T00:00:00Z'),
  ];

  it('itemizes a ticket by stage with a total', () => {
    const report = storyReport(config, 'DEMO-1', { rows });
    assert.equal(report.epic, 'demo');
    assert.deepEqual(report.stages.map((s) => [s.stage, s.runs, s.costUsd]), [['implement', 1, 2.7], ['review', 2, 1]]);
    assert.equal(report.total.costUsd, 3.7);
    assert.equal(report.total.unmeasuredRuns, 1);
    assert.equal(report.stages[0].cacheHitRate, 0.5);
    assert.deepEqual(Object.keys(report.stages[0].models), ['claude-sonnet-5.5', 'claude-haiku-5.5']);
    assert.match(formatStory(report), /1 run\(s\) reported no token usage/);
  });

  it('rolls tickets up to the epic and the long-term overview', () => {
    const epic = epicReport(config, 'demo', { rows });
    assert.deepEqual(epic.stories.map((s) => [s.story, s.total.costUsd]), [['DEMO-1', 3.7], ['DEMO-2', 0]]);
    assert.equal(epic.total.unpricedTokens, 500);
    const overview = overviewReport(config, { rows, since: '2026-07-15' });
    assert.deepEqual(overview.months.map((m) => m.key), ['2026-08']);
    assert.equal(overview.total.runs, 1);
  });
});

describe('runAgent records usage', () => {
  it('writes token-usage.jsonl from a custom agent command via PIPELINE_USAGE_FILE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-run-'));
    after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.github/agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts/pipeline'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github/agents/echo.agent.md'), '---\nname: echo\n---\nAnswer.\n');
    fs.writeFileSync(path.join(root, 'scripts/pipeline/pricing.json'), JSON.stringify(pricing));
    const agent = path.join(root, 'agent.mjs');
    fs.writeFileSync(agent, "import fs from 'node:fs'; fs.writeFileSync(process.env.PIPELINE_USAGE_FILE, JSON.stringify({ models: [{ model: 'claude-haiku-5-5', input: 50000, output: 0 }] })); console.log('done');\n");
    const base = loadConfig(null, ROOT);
    const config = { ...base, root, metricsDir: '.agent-metrics', agent: { ...base.agent, cmd: `"${process.execPath}" "${agent}"` } };
    const result = runAgent(config, { name: 'echo', task: 'hi', usage: { stage: 'implement', story: 'DEMO-9', round: 2 } });
    assert.equal(result.output.trim(), 'done');
    const [rec] = loadUsage(config);
    assert.deepEqual([rec.story, rec.stage, rec.round, rec.model, rec.measured, rec.cost_usd], ['DEMO-9', 'implement', 2, 'claude-haiku-5.5', true, 0.005]);
  });
});
