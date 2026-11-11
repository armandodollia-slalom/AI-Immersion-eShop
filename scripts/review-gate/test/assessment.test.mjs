// Review gate, step 1: systems, severity, confidence, the triage agent's result, the `## Triage`
// section, the board fields, and the assessment of a published PR (fake agent, fake GitHub).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { parseTriage, runTriage } from '../lib/assess.mjs';
import { assessTicket, ticketFilesLocal } from '../lib/assessment.mjs';
import { confidence, criteria, ticketSignals } from '../lib/confidence.mjs';
import { ensureFields, setTriageFields } from '../lib/fields.mjs';
import { bumpLevel, maxLevel, normalizeLevel } from '../lib/levels.mjs';
import { loadGateState, publishGate } from '../lib/publish.mjs';
import { prClass, prSeverity, ticketSeverity } from '../lib/severity.mjs';
import { codeownersMatch, ownersOfFiles, parseCodeowners, systemsTouched } from '../lib/systems.mjs';
import { extractTriage, keepTriage, upsertTriage } from '../lib/triage-section.mjs';
import { fakeGh } from './fake-gh.mjs';
import { SETTINGS, cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, low } from './helpers.mjs';

test('levels: normalize, max and bump capped at Severe', () => {
  assert.equal(normalizeLevel('medium'), 'Medium');
  assert.equal(normalizeLevel('huge'), null);
  assert.equal(maxLevel('Low', null, 'High', 'Medium'), 'High');
  assert.equal(maxLevel(), null);
  assert.equal(bumpLevel('Medium', 1), 'High');
  assert.equal(bumpLevel('High', 3), 'Severe');
});

test('systems: every changed file maps to its service; shared infrastructure and contracts are their own systems', () => {
  const s = systemsTouched(
    ['src/Identity.API/Program.cs', 'src/Ordering.Domain/Order.cs', 'src/Ordering.API/Application/IntegrationEvents/Events/OrderPaid.cs', 'src/eShop.ServiceDefaults/Extensions.cs', 'tests/Basket.UnitTests/X.cs', 'docs/a.md', 'scripts/foo.mjs'],
    SETTINGS,
  );
  assert.deepEqual(s.names, ['Ordering.API', 'Identity.API', 'Integration events', 'ServiceDefaults', 'Other']);
  assert.equal(s.shared, true);
  assert.equal(s.contract, true);
  const web = systemsTouched(['src/WebAppComponents/Item.razor', 'src/WebApp/Program.cs'], SETTINGS);
  assert.deepEqual(web.names, ['WebApp']);
  assert.equal(web.shared, false);
  assert.deepEqual(systemsTouched(['tests/X.cs', 'e2e/a.spec.ts'], SETTINGS).names, []);
});

test('CODEOWNERS: last matching rule wins, directories match their subtree', () => {
  const rules = parseCodeowners('# owners\n* @a @b\nsrc/Identity.API/ @sec # security\n*.razor @ui\n');
  assert.ok(codeownersMatch('src/Identity.API/Program.cs', 'src/Identity.API/'));
  assert.ok(codeownersMatch('src/WebApp/Pages/A.razor', '*.razor'));
  assert.ok(!codeownersMatch('src/Identity.API.cs', 'src/Identity.API/'));
  assert.deepEqual(ownersOfFiles(['src/Identity.API/Program.cs'], rules), ['sec']);
  assert.deepEqual(ownersOfFiles(['src/Basket.API/A.cs', 'src/WebApp/B.razor'], rules), ['a', 'b', 'ui']);
});

test('ticket severity: max(Impact, Fix risk), complexity shown but not counted, floors and reopen bumps explained', () => {
  const plain = ticketSeverity({ impact: 'Medium', complexity: 'Severe', fixRisk: 'Low' }, SETTINGS);
  assert.equal(plain.level, 'Medium');
  assert.equal(plain.explanation, 'Impact Medium, Fix risk Low → Medium');
  const reopened = ticketSeverity({ impact: 'Medium', fixRisk: 'Low', reopens: 1 }, SETTINGS);
  assert.equal(reopened.level, 'High');
  assert.equal(reopened.base, 'Medium');
  assert.equal(reopened.bump, 1);
  assert.equal(reopened.explanation, 'Impact Medium, Fix risk Low → Medium, +1 reopen → High');
  const floored = ticketSeverity({ impact: 'Low', fixRisk: 'Low', floorReasons: ['src/Identity.API/**'] }, SETTINGS);
  assert.equal(floored.level, 'High');
  assert.match(floored.explanation, /floor High \(src\/Identity\.API\/\*\*\) → High/);
  assert.equal(ticketSeverity({ impact: 'Severe', fixRisk: 'Low', reopens: 2 }, SETTINGS).level, 'Severe');
  assert.equal(ticketSeverity({}, SETTINGS).level, null);
});

test('PR severity: max ticket severity, +1 for 3+ systems, High floor for shared infrastructure or a contract', () => {
  const t = (level) => ({ severity: { level } });
  const sys = (names, extra = {}) => ({ names, shared: false, contract: false, ...extra });
  assert.equal(prSeverity({ tickets: [t('Low'), t('Medium')], systems: sys(['Basket.API']) }, SETTINGS).level, 'Medium');
  const many = prSeverity({ tickets: [t('Low')], systems: sys(['Basket.API', 'Catalog.API', 'WebApp']) }, SETTINGS);
  assert.equal(many.level, 'Medium');
  assert.match(many.explanation, /\+1 for 3 systems/);
  const shared = prSeverity({ tickets: [t('Low')], systems: sys(['EventBus'], { shared: true }) }, SETTINGS);
  assert.equal(shared.level, 'High');
  assert.match(shared.explanation, /shared infrastructure/);
  assert.equal(prSeverity({ tickets: [t('Low'), t(null)], systems: sys([]) }, SETTINGS).level, null);
  assert.equal(prClass({ severity: 'High', shared: true }), 'High+shared');
});

test('confidence: high only when every pipeline signal is met; the agent estimate is one input', () => {
  const clean = { bugFixCycles: 0, pairRounds: 1, pairsApproved: true, outsideOwns: 0, prCheckRounds: 1, prCheckScore: 10, ci: 'success', agent: 90 };
  const c = confidence(clean, SETTINGS.confidence);
  assert.equal(c.high, true);
  assert.equal(c.score, 98);
  const qe = confidence({ ...clean, bugFixCycles: 1 }, SETTINGS.confidence);
  assert.equal(qe.high, false);
  assert.match(qe.reasons.join(), /QE first try unmet/);
  assert.equal(confidence({ ...clean, pairRounds: 3 }, SETTINGS.confidence).high, false);
  assert.equal(confidence({ ...clean, prCheckRounds: null, prCheckScore: 8 }, SETTINGS.confidence).criteria.prCheck, 'unmet');
  assert.equal(confidence({ ...clean, ci: 'pending' }, SETTINGS.confidence).criteria.ci, 'pending');
  // A doubtful agent alone can block high confidence, but not raise it.
  const doubtful = confidence({ ...clean, agent: 10 }, SETTINGS.confidence);
  assert.equal(doubtful.high, false);
  assert.match(doubtful.reasons.join(), /agent estimate 10/);
  assert.equal(criteria({ bugFixCycles: null }).qe, 'unknown');
});

test('ticket signals come from the story outcome, its subtask runs and its PR checks', () => {
  const metrics = {
    outcomes: [{ ts: '1', type: 'story', story: 'BUG-1', decisionId: 'd2', bugFixCycles: 0 }],
    subtaskRuns: [
      { story: 'BUG-1', decisionId: 'd1', rounds: [{}, {}, {}], approved: false },
      { story: 'BUG-1', decisionId: 'd2', rounds: [{}, { outOfOwnsEdits: 1 }], approved: true, filesNeededOutsideOwns: [] },
    ],
    prChecks: [
      { ts: '1', stories: ['BUG-1', 'BUG-2'], score: 8 },
      { ts: '2', story: 'BUG-1', score: 10 },
    ],
  };
  const s = ticketSignals('BUG-1', metrics, { ci: 'success' });
  assert.deepEqual({ ...s }, { bugFixCycles: 0, pairRounds: 2, pairsApproved: true, outsideOwns: 1, prCheckRounds: 2, prCheckScore: 10, ci: 'success', agent: null });
});

test('triage result: levels and reasons validated per ticket; one retry with the errors', () => {
  const bad = parseTriage({ tickets: [{ key: 'BUG-1', impact: 'Big', fixRisk: 'Low', complexity: 'Low' }, { key: 'BUG-9' }] }, ['BUG-1', 'BUG-2']);
  for (const re of [/impact must be/, /impactReason is missing/, /unknown ticket "BUG-9"/, /BUG-2: no rating/]) assert.ok(bad.errors.some((e) => re.test(e)), `${re}`);
  const agent = fakeTriage((attempt) => (attempt === 1 ? { tickets: [] } : { tickets: [{ key: 'BUG-1', ...low, impactReason: 'a', complexityReason: 'b', fixRiskReason: 'c', categories: ['auth', 'weird'], confidence: 140 }] }));
  const r = runTriage(gateConfigFor('/tmp'), { pr: 'u', tickets: [{ key: 'BUG-1', text: 'x' }], systems: { names: [] }, files: [], diff: '' }, { runAgent: agent.runAgent });
  assert.equal(agent.calls.length, 2);
  assert.match(agent.calls[1].task, /previous result was invalid/);
  assert.equal(agent.calls[0].mode, 'read');
  assert.equal(agent.calls[0].name, 'bug-triage');
  assert.deepEqual(r.ratings.get('BUG-1').categories, ['auth']);
  assert.equal(r.ratings.get('BUG-1').agentConfidence, 100);
});

test('the Triage section round-trips its data and survives a re-rendered body', () => {
  const data = { key: 'BUG-1', pr: 'https://x/pull/1', impact: 'Medium', impactReason: 'a | b', severity: { level: 'High', explanation: 'Impact Medium, Fix risk Low → Medium, +1 reopen → High' }, confidence: { score: 70, high: false, reasons: ['CI pending'] }, systems: ['Identity.API'], reopens: [{ at: '2026-11-02T00:00:00Z', source: 'card' }] };
  const body = upsertTriage('<!-- board-ticket:v1\n{}\n-->\nstory', data);
  assert.match(body, /## Triage/);
  assert.match(body, /a \\\| b/);
  assert.match(body, /\*\*High\*\*/);
  assert.match(body, /Human reopens:\*\* 1/);
  assert.deepEqual(extractTriage(body), data);
  const again = upsertTriage(body, { ...data, impact: 'Low' });
  assert.equal(again.split('## Triage').length, 2);
  assert.equal(extractTriage(again).impact, 'Low');
  assert.equal(extractTriage(keepTriage('fresh body', body)).key, 'BUG-1');
});

test('board fields: setup creates the missing ones; values are written per ticket card', () => {
  const gh = fakeGh();
  gh.addFields(['Impact']);
  const config = gateConfigFor('/tmp');
  assert.deepEqual(ensureFields(config, gh.gh), ['Complexity', 'Fix risk', 'Severity', 'Confidence', 'Human reopens']);
  assert.deepEqual(ensureFields(config, gh.gh), []);
  gh.items.set(7, { id: 'I_7', values: { Severity: 'Low' } });
  setTriageFields(config, gh.gh, { number: 7, url: 'https://github.com/acme/shop/issues/7' }, { impact: 'Medium', severity: 'High', confidence: 64, reopens: 1, fixRisk: null });
  assert.deepEqual(gh.items.get(7).values, { Severity: 'High', Impact: 'Medium', Confidence: 64, 'Human reopens': 1 });
});

test('group PRs: each ticket gets the files of its own merge into the group branch', () => {
  const root = fixRepo({ merges: [{ key: 'BUG-1', files: { 'src/Basket.API/A.cs': 'a' } }, { key: 'BUG-2', files: { 'src/Identity.API/B.cs': 'b' } }] });
  const all = ['src/Basket.API/A.cs', 'src/Identity.API/B.cs'];
  assert.deepEqual(ticketFilesLocal(root, 'main', ['BUG-1', 'BUG-2'], all), { 'BUG-1': ['src/Basket.API/A.cs'], 'BUG-2': ['src/Identity.API/B.cs'] });
  assert.deepEqual(ticketFilesLocal(root, 'main', ['BUG-1'], all), { 'BUG-1': all });
});

test('assessTicket: an override path in the ticket\'s files raises it to High; earlier reopens bump it', () => {
  const t = assessTicket({ ticket: { key: 'BUG-2', title: 't', issue: null }, rating: { ...low, categories: [], agentConfidence: 90 }, files: ['src/Identity.API/B.cs'], systemsSettings: SETTINGS, signals: { bugFixCycles: 0 }, prior: { reopens: [{ at: 'x', source: 'card' }] }, settings: SETTINGS });
  assert.deepEqual(t.floorReasons, ['src/Identity.API/**']);
  assert.equal(t.severity.level, 'Severe');
  assert.equal(t.severity.explanation, 'Impact Low, Fix risk Low → Low, floor High (src/Identity.API/**) → High, +1 reopen → Severe');
  assert.deepEqual(t.systems, ['Identity.API']);
});

test('publish: assesses a group PR, writes the Triage section, the board fields and a bug-triage decision', () => {
  const root = fixRepo({ merges: [{ key: 'BUG-1', files: { 'src/Basket.API/A.cs': 'a' } }, { key: 'BUG-2', files: { 'src/Identity.API/B.cs': 'b' } }] });
  cacheTicket(root, 'BUG-1', { number: 11 });
  cacheTicket(root, 'BUG-2', { number: 12 });
  cleanMetrics(root, ['BUG-1', 'BUG-2']);
  const gh = fakeGh();
  gh.addFields();
  gh.addIssue(11, { body: 'story 11' });
  gh.addIssue(12, { body: 'story 12' });
  gh.items.set(11, { id: 'I_11', values: {} });
  gh.items.set(12, { id: 'I_12', values: {} });
  gh.addPr(5, { checks: [{ name: 'ci', bucket: 'pass' }] });
  const agent = fakeTriage({ 'BUG-1': low, 'BUG-2': { ...low, impact: 'Medium' } });
  const config = gateConfigFor(root);
  const pr = 'https://github.com/acme/shop/pull/5';
  const { assessment } = publishGate(config, { pr, keys: ['BUG-1', 'BUG-2'], base: 'main' }, { gh: gh.gh, runAgent: agent.runAgent });

  assert.match(agent.calls[0].task, /src\/Identity\.API\/B\.cs/);
  assert.match(agent.calls[0].task, /BUG-2: Something is broken/);
  assert.deepEqual(assessment.systems.names, ['Basket.API', 'Identity.API']);
  const [b1, b2] = assessment.tickets;
  assert.equal(b1.severity.level, 'Low');
  assert.equal(b1.confidence.high, true);
  assert.equal(b2.severity.level, 'High', 'Identity.API is an override path');
  assert.equal(assessment.severity.level, 'High');
  assert.equal(assessment.class, 'High');
  assert.equal(extractTriage(gh.issues.get(12).body).severity.level, 'High');
  assert.match(gh.issues.get(11).body, /^story 11/);
  assert.deepEqual(gh.items.get(12).values, { Impact: 'Medium', Complexity: 'Low', 'Fix risk': 'Low', Severity: 'High', Confidence: 98, 'Human reopens': 0 });
  const [decision] = readJsonl(path.join(root, '.agent-metrics/decisions.jsonl'));
  assert.equal(decision.stage, 'bug-triage');
  assert.equal(decision.pr_severity, 'High');
  assert.deepEqual(decision.stories, ['BUG-1', 'BUG-2']);
  assert.equal(decision.items[1].severity, 'High');
  assert.equal(loadGateState(config, pr).assessment.class, 'High');
  assert.ok(fs.existsSync(path.join(root, '.agent-state/review-gate/pr-5.json')));
});
