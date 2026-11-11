// Mockups for the builders and the UI verifier: which files a story gets (its own, and the epic's when the
// epic was handed over), the Design canvas parsing, and the Playwright renders (every screen and state,
// cached by the mockups' sha), with a tiny fixture canvas.
/* global window -- used inside page.evaluate callbacks, which run in the browser */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { dcProps, dcRuntime, dcTemplate, dcVariants, formatMockups, formatRenders, isDesignCanvas, loadChromium, mockupSha, pixelDiff, renderMockups, renderScreens, screenSize, storyMockups } from '../lib/mockups.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mockups', 'DEMO-1-coupon');
const fixtureFiles = fs.readdirSync(fixture).map((f) => path.join(fixture, f)).sort();
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mockups-')));

// Chromium may be missing on a machine without `npx playwright install chromium`: skip the render tests.
const browserSkip = await (async () => {
  try {
    const b = await (await loadChromium()).launch();
    await b.close();
    return false;
  } catch (error) {
    return `Playwright Chromium is not available: ${error.message.split('\n')[0]}`;
  }
})();

test('a story gets its own mockups, and its epic\'s only when the epic was handed to the run', () => {
  const root = tmp();
  const config = { root, stateDir: '.agent-state', tickets: { dir: '.agent-state/board' }, abs: (p) => path.join(root, p) };
  seedTicket(root, { key: 'epic-coupons', type: 'epic', text: '# Epic: Coupons\n', mockups: { 'epic-coupons-journey/Journey.dc.html': '<x-dc></x-dc>' } });
  seedTicket(root, { key: 'DEMO-2', text: '# DEMO-2 Wrap\n', mockups: { 'DEMO-2-wrap/Main.png': 'png' } });
  const storyFile = path.join(root, seedTicket(root, { key: 'DEMO-1', text: '# DEMO-1 Coupon\n', parent: 'epic-coupons', mockups: { 'DEMO-1-coupon/README.md': '# r', 'DEMO-1-coupon/Main.dc.html': '<x-dc></x-dc>' } }));

  const own = storyMockups(config, storyFile, {});
  assert.deepEqual(own.map((g) => [g.key, g.source, g.files.map((f) => path.basename(f))]), [['DEMO-1', 'story', ['Main.dc.html', 'README.md']]]);
  assert.ok(own[0].files.every((f) => path.isAbsolute(f)));

  const epicDir = path.join(root, '.agent-state', 'board', 'epic-coupons');
  for (const env of [{ PIPELINE_STORY_SOURCES: epicDir }, { PIPELINE_STORY_SOURCES: 'epic-coupons' }]) {
    const groups = storyMockups(config, storyFile, env);
    assert.deepEqual(groups.map((g) => [g.key, g.source]), [['DEMO-1', 'story'], ['epic-coupons', 'epic']], JSON.stringify(env));
    assert.match(formatMockups(groups), /Epic epic-coupons \(the journey across its stories\):\n {2}- .*Journey\.dc\.html/);
  }
  assert.equal(storyMockups(config, storyFile, { PIPELINE_STORY_SOURCES: 'DEMO-2' }).length, 1, 'another story handed to the run is not this story\'s mockup');
});

test('design canvas parsing: template blocks become templates, props, preview size and the states to render', () => {
  const html = fs.readFileSync(path.join(fixture, 'Main.dc.html'), 'utf8');
  assert.ok(isDesignCanvas(html));
  assert.equal(isDesignCanvas('<html><body>plain</body></html>'), false);
  const template = dcTemplate(html);
  assert.match(template, /<template data-sc="for" list="\{\{rows\}\}" as="row"/);
  assert.match(template, /<\/template>/);
  assert.doesNotMatch(template, /<\/?sc-/);
  assert.deepEqual(dcProps(html).showError, { editor: 'boolean', default: false, section: 'State' });
  assert.deepEqual(screenSize(html), { width: 480, height: 320 });
  assert.deepEqual(screenSize('<html></html>', { w: 800, h: 600 }), { width: 800, height: 600 }, 'the canvas.json artboard');
  assert.deepEqual(screenSize('<html></html>'), { width: 1440, height: 1024 });

  const variants = dcVariants({ props: { ...dcProps(html), mode: { editor: 'select', default: 'a', options: ['a', 'b', { value: 'c' }] } }, initialState: { applied: false, code: 'FALL10' } });
  assert.deepEqual(variants.map((v) => v.name), ['default', 'showError=true', 'mode=b', 'mode=c', 'state.applied=true']);
  assert.deepEqual(variants[1].props, { showError: true });
  assert.deepEqual(variants[4].state, { applied: true });
  assert.equal(dcVariants({ initialState: Object.fromEntries([...'abcdefghij'].map((k) => [k, false])) }, { max: 4 }).length, 4, 'capped');
});

test('the in-page canvas runtime fills values, repeats rows inside tables, shows states and wires clicks', { skip: browserSkip }, async () => {
  const html = fs.readFileSync(path.join(fixture, 'Main.dc.html'), 'utf8');
  const browser = await (await loadChromium()).launch();
  try {
    const open = async (variant) => {
      const page = await browser.newPage();
      await page.addInitScript(dcRuntime, { template: dcTemplate(html), variant });
      await page.goto(pathToFileURL(path.join(fixture, 'Main.dc.html')).href);
      return page;
    };
    const page = await open({ props: {}, state: {} });
    assert.equal(await page.textContent('#title'), 'Apply a coupon (FALL10)');
    assert.deepEqual(await page.$$eval('table tbody td.row', (tds) => tds.map((td) => td.textContent)), ['Trekking boots', 'Jacket']);
    assert.equal(await page.$('#error'), null);
    assert.equal(await page.$('#applied'), null);
    assert.deepEqual(await page.evaluate(() => window.__dc), { props: { showError: { editor: 'boolean', default: false, section: 'State' }, $preview: { width: 480, height: 320 } }, initialState: { applied: false, code: 'FALL10' } });
    await page.click('button');
    assert.equal(await page.textContent('#applied'), 'Coupon applied', 'onClick calls the component');
    assert.ok(await (await open({ props: { showError: true }, state: {} })).$('#error'));
    assert.ok(await (await open({ props: {}, state: { applied: true } })).$('#applied'));
  } finally {
    await browser.close();
  }
});

test('renders every screen and state to PNGs once per set of mockups, copies them into each round, and diffs', { skip: browserSkip }, async () => {
  const dir = tmp();
  const cacheDir = path.join(dir, 'cache');
  let renders = 0;
  const counting = async (...args) => (renders++, renderScreens(...args));

  const r1 = await renderMockups({ files: fixtureFiles, outDir: path.join(dir, 'round-1', 'mockup'), cacheDir, render: counting });
  assert.ok(r1.ok, r1.error);
  assert.equal(r1.cached, false);
  const screens = r1.entries.filter((e) => e.kind === 'screen');
  assert.deepEqual(screens.map((e) => e.state), ['default', 'showError=true', 'state.applied=true']);
  assert.ok(screens.every((e) => e.title === '1 · Apply coupon' && e.width === 480 && !e.error), JSON.stringify(screens));
  for (const e of screens) {
    assert.equal(path.dirname(e.png), path.join(dir, 'round-1', 'mockup'));
    assert.deepEqual([...fs.readFileSync(e.png).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
  }
  assert.deepEqual(r1.entries.filter((e) => e.kind === 'image').map((e) => e.png), [path.join(fixture, 'Main.png')], 'image mockups are used where they are');
  assert.ok(fs.existsSync(path.join(dir, 'round-1', 'mockup', 'manifest.json')));
  assert.match(formatRenders(r1.entries), /- Main\.dc\.html \(1 · Apply coupon\), state showError=true: .*DEMO-1-coupon__Main--showError=true\.png/);

  const r2 = await renderMockups({ files: fixtureFiles, outDir: path.join(dir, 'round-2', 'mockup'), cacheDir, render: counting });
  assert.equal(renders, 1, 'the second round reuses the render');
  assert.equal(r2.cached, true);
  assert.equal(r2.sha, r1.sha);
  assert.ok(r2.entries.filter((e) => e.kind === 'screen').every((e) => fs.existsSync(e.png) && path.dirname(e.png) === path.join(dir, 'round-2', 'mockup')));

  // A changed mockup is a new sha and a new render.
  const changed = path.join(dir, 'changed');
  fs.cpSync(fixture, changed, { recursive: true });
  fs.appendFileSync(path.join(changed, 'Main.dc.html'), '\n');
  const files = fs.readdirSync(changed).map((f) => path.join(changed, f));
  assert.notEqual(mockupSha(files), r1.sha);
  await renderMockups({ files, outDir: path.join(dir, 'round-3', 'mockup'), cacheDir, render: counting });
  assert.equal(renders, 2);

  const same = await pixelDiff(screens[0].png, screens[0].png, path.join(dir, 'same.png'));
  assert.equal(same.differing, 0);
  const diff = await pixelDiff(screens[0].png, screens[1].png, path.join(dir, 'diff.png'));
  assert.ok(diff.differing > 0 && diff.ratio > 0 && fs.existsSync(diff.diff), JSON.stringify(diff));
});

test('a render that cannot run is reported, not thrown', async () => {
  const dir = tmp();
  const r = await renderMockups({ files: fixtureFiles, outDir: path.join(dir, 'out'), cacheDir: path.join(dir, 'cache'), render: async () => { throw new Error('no browser'); } });
  assert.deepEqual([r.ok, r.error, r.entries], [false, 'no browser', []]);
  assert.match(formatRenders([{ kind: 'screen', screen: 'Main.dc.html', state: 'default', png: null, error: 'timeout', source: '/m/Main.dc.html' }]), /not rendered \(timeout\); read \/m\/Main\.dc\.html/);
  assert.deepEqual(await renderMockups({ files: [], outDir: dir, cacheDir: dir }), { ok: true, sha: null, cached: false, entries: [] });
});
