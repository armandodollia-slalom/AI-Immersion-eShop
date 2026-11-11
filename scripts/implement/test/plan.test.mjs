// Plan validation, owns globs, scope enforcement, verdict parsing and model classes of the orchestrated
// implement flow (pure functions).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globsOverlap, isUiStory, matchGlob, parsePlanOutput, parseVerdict, resolveModel, resolveModelForRole, scopeViolations, topoOrder, validatePlan, validateRewrite } from '../lib/plan.mjs';

const BE = '# DEMO-1: [BE - Catalog.API] - Thing\n\n## Acceptance Criteria\n\n- a\n';
const FE = '# DEMO-2: [FE - WebApp] - Page\n';
const limits = { maxSubtasks: 4, maxLargeSubtasks: 1 };
const sub = (id, owns, over = {}) => ({ id, goal: `do ${id}`, acceptance: ['works'], owns, dependsOn: [], modelClass: 'medium', verify: 'code', modelReason: 'normal work', verifyReason: 'api only', expectedFiles: 2, expectedLoc: 50, confidence: 0.8, alternatives: [], ...over });
const plan = (subtasks, over = {}) => ({ mode: 'delegate', modeReason: 'two services', splitReason: 'one per service', subtasks, ...over });

test('a valid delegate plan is normalized and keeps the reasoning apart from the spec', () => {
  const v = validatePlan(plan([sub('api', ['src/Catalog.API/**']), sub('web', ['src/WebApp/**'], { dependsOn: ['api'] })]), { storyText: BE, limits });
  assert.ok(v.ok, v.errors.join('\n'));
  assert.equal(v.plan.mode, 'delegate');
  assert.deepEqual(v.plan.subtasks[1].dependsOn, ['api']);
  assert.equal(v.plan.subtasks[0].decision.modelReason, 'normal work');
  assert.equal(v.plan.subtasks[0].modelReason, undefined, 'reasons live under decision only');
});

test('schema errors are listed one by one', () => {
  const v = validatePlan(plan([{ id: 'Bad Id', owns: [], modelClass: 'huge', verify: 'manual' }]), { storyText: BE, limits });
  assert.ok(!v.ok);
  for (const re of [/`id` must match/, /`goal` is required/, /`acceptance`/, /`owns` must be a non-empty list/, /`modelClass` must be one of/, /`verify` must be/, /`modelReason` is required/, /`expectedLoc`/, /`confidence`/]) assert.ok(v.errors.some((e) => re.test(e)), `missing ${re}`);
  assert.ok(!validatePlan({ mode: 'other' }, { limits }).ok);
  assert.ok(!validatePlan(null, { limits }).ok);
  assert.ok(validatePlan(plan([sub('a', ['src/A/**'])], { splitReason: '' }), { storyText: BE, limits }).errors.some((e) => /splitReason/.test(e)));
});

test('more than maxSubtasks is fatal: the story must be split (no second chance)', () => {
  const v = validatePlan(plan(['a', 'b', 'c', 'd', 'e'].map((id) => sub(id, [`src/${id}/**`]))), { storyText: BE, limits });
  assert.ok(!v.ok);
  assert.match(v.fatal[0], /^split the story: the plan has 5 subtasks and at most 4/);
});

test('overlapping owns are rejected', () => {
  const v = validatePlan(plan([sub('a', ['src/Catalog.API/**']), sub('b', ['src/Catalog.API/Apis/*.cs'])]), { storyText: BE, limits });
  assert.ok(v.errors.some((e) => /subtasks a and b both own/.test(e)));
  assert.ok(validatePlan(plan([sub('a', ['src/WebApp/**/*.razor']), sub('b', ['src/WebApp/**/*.cs'])]), { storyText: FE, limits }).ok, 'disjoint by extension');
  assert.ok(validatePlan(plan([sub('a', ['**'])]), { storyText: BE, limits }).errors.some((e) => /whole repo/.test(e)));
  assert.ok(validatePlan(plan([sub('a', ['../x/**'])]), { storyText: BE, limits }).errors.some((e) => /without "\.\."/.test(e)));
});

test('dependsOn must name other subtasks and be acyclic', () => {
  assert.ok(validatePlan(plan([sub('a', ['src/A/**'], { dependsOn: ['zzz'] })]), { storyText: BE, limits }).errors.some((e) => /dependsOn "zzz"/.test(e)));
  assert.ok(validatePlan(plan([sub('a', ['src/A/**'], { dependsOn: ['a'] })]), { storyText: BE, limits }).errors.some((e) => /dependsOn "a"/.test(e)));
  const cyc = validatePlan(plan([sub('a', ['src/A/**'], { dependsOn: ['b'] }), sub('b', ['src/B/**'], { dependsOn: ['a'] })]), { storyText: BE, limits });
  assert.ok(cyc.errors.some((e) => /dependency cycle/.test(e)));
});

test('at most one large subtask, and it needs a justification', () => {
  const noJust = validatePlan(plan([sub('a', ['src/A/**'], { modelClass: 'large' })]), { storyText: BE, limits });
  assert.ok(noJust.errors.some((e) => /needs a `justification`/.test(e)));
  const two = validatePlan(plan([sub('a', ['src/A/**'], { modelClass: 'large', justification: 'x' }), sub('b', ['src/B/**'], { modelClass: 'large', justification: 'y' })]), { storyText: BE, limits });
  assert.ok(two.errors.some((e) => /at most 1 subtask\(s\) may use modelClass "large"/.test(e)));
});

test('verify "ui" only for UI stories, and a false uiStory claim is caught', () => {
  assert.ok(validatePlan(plan([sub('a', ['src/WebApp/**'], { verify: 'ui' })]), { storyText: FE, limits }).ok);
  assert.ok(validatePlan(plan([sub('a', ['src/Catalog.API/**'], { verify: 'ui' })]), { storyText: BE, limits }).errors.some((e) => /only allowed for UI stories/.test(e)));
  assert.ok(validatePlan(plan([sub('a', ['src/A/**'])], { uiStory: true }), { storyText: BE, limits }).errors.some((e) => /`uiStory` is true but/.test(e)));
});

test('UI story detection: [FE] tag, WebApp in the title components, or a .razor file', () => {
  assert.ok(isUiStory(FE));
  assert.ok(isUiStory('# X-1: [BE - Basket.API, WebApp] - Mixed\n'));
  assert.ok(isUiStory('# X-2: [BE - Catalog.API] - Y\n\nChange `src/WebApp/Components/Pages/Item.razor`.'));
  assert.ok(!isUiStory('# X-3: [BE - Promotions.API] - Y\n\nThe WebApp will later call this API.'));
});

test('self mode: one implicit subtask that owns everything', () => {
  const v = validatePlan({ mode: 'self', modeReason: 'one service', subtasks: [{ goal: 'all', acceptance: ['x'], verify: 'ui' }] }, { storyText: FE, limits });
  assert.ok(v.ok, v.errors.join('\n'));
  assert.deepEqual(v.plan.subtasks.map((s) => [s.id, s.owns, s.verify, s.self]), [['self', ['**'], 'ui', true]]);
  assert.ok(!validatePlan({ mode: 'self', modeReason: 'x', subtasks: [{}, {}] }, { storyText: BE, limits }).ok);
  assert.ok(!validatePlan({ mode: 'self' }, { storyText: BE, limits }).ok, 'modeReason is required');
});

test('globs: * stays in a segment, ** crosses them, a bare path covers its subtree', () => {
  assert.ok(matchGlob('src/Catalog.API/Apis/CatalogApi.cs', 'src/Catalog.API/**'));
  assert.ok(matchGlob('src/Catalog.API/x.cs', 'src/Catalog.API'));
  assert.ok(matchGlob('src/a/b/c.razor', 'src/**/*.razor'));
  assert.ok(matchGlob('src/c.razor', 'src/**/*.razor'), '**/ matches zero directories');
  assert.ok(!matchGlob('src/a/b.cs', 'src/*.cs'));
  assert.ok(globsOverlap('src/**', 'src/A/x.cs'));
  assert.ok(globsOverlap('src/*/Apis/**', 'src/Catalog.API/**'));
  assert.ok(!globsOverlap('src/A/**', 'src/B/**'));
  assert.ok(!globsOverlap('src/A/*.cs', 'src/A/*.razor'));
  assert.ok(!globsOverlap('Directory.Packages.props', 'src/**'));
});

test('scope enforcement lists changed files outside owns', () => {
  assert.deepEqual(scopeViolations(['src/A/x.cs', 'src/B/y.cs', 'Directory.Packages.props'], ['src/A/**', 'Directory.Packages.props']), ['src/B/y.cs']);
});

test('topological order keeps plan order and puts dependencies first', () => {
  assert.deepEqual(topoOrder([{ id: 'c', dependsOn: ['b'] }, { id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }]).map((s) => s.id), ['a', 'b', 'c']);
});

test('the plan is read from the AGENT_RESULT marker or the last ```json block', () => {
  assert.deepEqual(parsePlanOutput('blah\nAGENT_RESULT: {"mode": "self"}\n'), { mode: 'self' });
  assert.deepEqual(parsePlanOutput('```json\n{"mode": "x"}\n```\nthen\n```json\n{"mode": "delegate"}\n```\n'), { mode: 'delegate' });
  assert.equal(parsePlanOutput('no plan'), null);
});

test('verdicts are strict: blocking findings need a file (code) or a screenshot (ui)', () => {
  const v = (o) => `x\nAGENT_RESULT: ${JSON.stringify(o)}`;
  assert.deepEqual(parseVerdict(v({ verdict: 'APPROVED', summary: 'ok', findings: [] })), { verdict: 'APPROVED', summary: 'ok', findings: [] });
  assert.equal(parseVerdict(v({ verdict: 'APPROVED', findings: [{ severity: 'blocking', file: 'a.cs', line: 1, issue: 'x' }] })).verdict, 'CHANGES_REQUESTED', 'blocking findings win');
  assert.equal(parseVerdict(v({ verdict: 'CHANGES_REQUESTED', findings: [] })), null, 'changes requested with nothing to change');
  assert.equal(parseVerdict(v({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'blocking', issue: 'no file' }] })), null);
  assert.equal(parseVerdict(v({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'blocking', screenshot: '/s/1.png', issue: 'hidden' }] }), { ui: true }).verdict, 'CHANGES_REQUESTED');
  assert.equal(parseVerdict(v({ verdict: 'MAYBE' })), null);
  assert.equal(parseVerdict('nothing'), null);
});

test('model classes map to allowed aliases, checked for the role\'s CLI; a role can use another CLI', () => {
  const agent = { cli: 'claude', cmd: null, models: {}, strictModels: true, allowedModels: ['opus', 'sonnet'], modelIds: { claude: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, copilot: { opus: 'claude-opus-5.5', sonnet: 'claude-sonnet-5.5' } } };
  const config = { agent, modelClasses: { small: 'sonnet', medium: 'sonnet', large: 'opus', bad: 'haiku' }, implement: { roles: { orchestrator: { modelClass: 'large' }, verifier: { cli: 'codex', modelClass: 'medium' }, uiVerifier: { cli: 'copilot', modelClass: 'large' } } } };
  assert.equal(resolveModel(config, 'pairImplementer', 'small'), 'sonnet');
  assert.equal(resolveModel(config, 'pairImplementer', 'large'), 'opus');
  assert.equal(resolveModel(config, 'pairImplementer', 'unknown'), null, 'no mapping and no default: the CLI default');
  assert.throws(() => resolveModel(config, 'pairImplementer', 'bad'), /Model "haiku" is not allowed/);
  assert.throws(() => resolveModel(config, 'verifier', 'medium'), /no id for agent CLI "codex"/, 'codex has no allowed model ids');
  assert.equal(resolveModelForRole(config, 'uiVerifier'), 'opus', 'the UI verifier runs on copilot, which has an opus id');
  assert.equal(resolveModel({ ...config, agent: { ...agent, cmd: 'x' } }, 'verifier', 'medium'), 'sonnet', 'a custom command gets the alias unchecked against a CLI');
  assert.equal(resolveModelForRole(config, 'orchestrator'), 'opus');
  assert.equal(resolveModelForRole({ ...config, agent: { ...agent, models: { implementer: 'sonnet' } } }, 'orchestrator'), 'sonnet', 'agent.models.implementer pins it');
  assert.throws(() => resolveModelForRole({ ...config, agent: { ...agent, models: { implementer: 'gpt-4' } } }, 'orchestrator'), /not allowed/);
});

test('a rewritten subtask keeps its id and must not overlap the others', () => {
  const original = { ...sub('a', ['src/A/**']), decision: { modelReason: 'm', verifyReason: 'v', expectedFiles: 1, expectedLoc: 1, confidence: 0.5, alternatives: [] } };
  const other = { ...sub('b', ['src/B/**']), decision: original.decision };
  const ok = validateRewrite(original, { id: 'zzz', goal: 'better goal', owns: ['src/A/**', 'src/Shared/**'] }, [other], { storyText: BE });
  assert.ok(ok.ok, ok.errors?.join('\n'));
  assert.equal(ok.subtask.id, 'a');
  assert.equal(ok.subtask.goal, 'better goal');
  assert.ok(!validateRewrite(original, { owns: ['src/B/x.cs'] }, [other], { storyText: BE }).ok);
});
