// The repo mixes xUnit v3 (functional tests) and MSTest.Sdk (unit tests); QE must tag and filter each
// project its own way. PROMO-1's run 3 failed every round by sending xUnit's --filter-trait to MSTest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { hasTests, storyTag, testFramework } from '../lib/workflows.mjs';

test('detects each test project framework from its csproj', () => {
  const config = loadConfig('qe');
  assert.equal(testFramework(config, 'tests/Catalog.FunctionalTests'), 'xunit');
  assert.equal(testFramework(config, 'tests/eShop.AppHost.UnitTests'), 'mstest');
  assert.equal(testFramework(config, 'tests/Ordering.UnitTests'), 'mstest');
  assert.equal(testFramework(config, 'tests/DoesNotExist.FunctionalTests'), 'xunit', 'a missing project falls back to xunit');
});

test('story tag matches the framework', () => {
  assert.ok(storyTag('xunit', 'PROMO-1').test('[Trait("Story", "PROMO-1")]'));
  assert.ok(!storyTag('xunit', 'PROMO-1').test('[TestCategory("PROMO-1")]'));
  assert.ok(storyTag('mstest', 'PROMO-1').test('[TestCategory( "PROMO-1" )]'));
  assert.ok(!storyTag('mstest', 'PROMO-1').test('[Trait("Story", "PROMO-1")]'));
  assert.ok(!storyTag('mstest', 'PROMO-1').test('[TestCategory("PROMO-12")]'));
});

test('config has a test command per framework, with the right filter', () => {
  const { dotnet } = loadConfig('qe').precheck;
  assert.ok(dotnet.xunit.includes('--filter-trait'));
  assert.ok(!dotnet.mstest.includes('--filter-trait'));
  assert.deepEqual(dotnet.mstest.slice(-2), ['--filter', 'TestCategory={story}']);
  for (const cmd of Object.values(dotnet)) assert.ok(cmd.includes('--no-build'));
});

test('hasTests: only files with a test attribute need the story tag', () => {
  assert.ok(hasTests('[Fact]\npublic void TC_PROMO_1_01() {}'));
  assert.ok(hasTests('[Theory, InlineData(1)]'));
  assert.ok(hasTests('[TestMethod]'));
  assert.ok(hasTests('[DataTestMethod]'));
  assert.ok(!hasTests('// Program is referenced for TC-PROMO-1-23\npublic sealed class PromotionsHost {}'));
});
