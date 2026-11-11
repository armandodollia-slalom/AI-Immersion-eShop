// Cost dashboards (`pipeline dashboard`): runs from token-usage rows, idle/outage bands, waste
// classification and the HTML render.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDashboard, buildRuns, classifyWaste, detectBands, renderHtml } from '../lib/dashboard.mjs';

const clock = (ts) => ({ day: 0, min: (Date.parse(ts) - Date.parse('2026-01-01T00:00:00Z')) / 60000 });
const at = (min) => new Date(Date.parse('2026-01-01T00:00:00Z') + min * 60000).toISOString();
const row = (o) => ({ run_id: o.id, model: o.model ?? 'claude-sonnet', ts: at(o.end), seconds: (o.min ?? 1) * 60, cost_usd: o.cost ?? 0.1, tokens: { input: 10, output: 5, cache_read: 100 }, story: o.story ?? 'BUG-1', stage: o.stage ?? 'implement', cli: o.cli ?? 'copilot', round: o.round ?? 1, ok: o.ok, _src: 'b' });

test('buildRuns merges the rows of one run on two models and keeps the costlier tier', () => {
  const runs = buildRuns([row({ id: 'r1', end: 10, cost: 0.1 }), row({ id: 'r1', end: 10, model: 'claude-opus', cost: 0.5 }), row({ id: 'r1', end: 10, cost: 0.1 })], clock, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].tier, 'opus');
  assert.equal(runs[0].tokens, 230);
  assert.equal(runs[0].start, 9);
});

test('detectBands calls a gap idle when the CLI is unchanged and an outage when it switched', () => {
  const runs = buildRuns([row({ id: 'a', end: 10 }), row({ id: 'b', end: 60 }), row({ id: 'c', end: 70, ok: false }), row({ id: 'd', end: 120, cli: 'claude' })], clock, 0);
  const bands = detectBands(runs, { minGap: 30 });
  assert.deepEqual(bands.map((b) => [b.kind, b.a, b.b]), [['idle', 10, 59], ['outage', 60, 119]]);
  assert.equal(bands[1].label, 'copilot out \u2192 claude');
});

test('classifyWaste splits rework by tier, CLI-switch redos and failed runs', () => {
  const runs = buildRuns([
    row({ id: 'a', end: 10, stage: 'plan' }),
    row({ id: 'b', end: 20, stage: 'plan', cli: 'claude' }),
    row({ id: 'c', end: 30, round: 2 }),
    row({ id: 'd', end: 40, round: 2, model: 'claude-opus' }),
    row({ id: 'e', end: 50, ok: false }),
  ], clock, 0);
  const { waste, pairs } = classifyWaste(runs);
  assert.deepEqual([waste.switch.runs, waste.sonnet.runs, waste.opus.runs, waste.failed.runs], [1, 1, 1, 1]);
  assert.deepEqual(pairs, { 'copilot\u2192claude': 1 });
});

test('renderHtml embeds the data without letting it close the script tag', () => {
  const d = buildDashboard({ 'token-usage': [row({ id: 'a', end: 10 })] }, { meta: [{ key: 'BUG-1', title: 'BUG-1: </script><b>x' }], title: 'T', generatedAt: at(0) });
  assert.equal(d.stories[0].title, '</script><b>x');
  for (const kind of ['epic', 'story']) {
    const html = renderHtml(kind, d);
    assert.ok(!html.includes('/*__DATA__*/'));
    assert.ok(!html.includes('"</script>'));
    assert.ok(html.includes('\\u003c/script>'));
  }
});
