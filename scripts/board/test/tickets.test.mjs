// Board tickets as the source of truth: issue body format, assets branch, fetch cache, the loader,
// migration (plan, apply, verify, delete-local). GitHub is the in-memory fake in fake-github.mjs; the
// assets branch lives in throwaway git repositories.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildAssetsCommit, downloadAssets, readAsset } from '../lib/assets.mjs';
import { classifyLegacy } from '../lib/legacy.mjs';
import { applyMigration, deleteLocal, planMigration, verifyMigration } from '../lib/migrate.mjs';
import { fetchTickets, readMeta, storyVersion, ticketFile, writeTicket } from '../lib/source.mjs';
import { BEGIN, BODY_LIMIT, END, metaFor, parseBody, renderBody, sha256 } from '../lib/ticket-format.mjs';
import { epicTickets, keyOfArg, keysFromPaths, listEpics, listStories, loadTicket, mockupFiles, orderByBlockers, resetTicketMemo, resolveStory } from '../../pipeline/lib/tickets.mjs';
import { storyDiffSince } from '../../qe/lib/workflows.mjs';
import { fakeGitHub } from './fake-github.mjs';

const REPO = 'acme/shop';
const temps = [];
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
});
const tmpDir = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(d);
  return d;
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

// A checkout with an origin (a bare repo), so the assets branch can be pushed and fetched.
function checkout({ legacy = null } = {}) {
  const base = tmpDir('tickets-');
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'shop');
  git(base, 'init', '-q', '--bare', origin);
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  git(root, 'remote', 'add', 'origin', origin);
  write(root, 'README.md', 'shop\n');
  write(root, '.gitignore', '.agent-state/\n');
  if (legacy) for (const [rel, data] of Object.entries(legacy)) if (data !== undefined) write(root, `legacy/${rel}`, data);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const config = {
    root,
    stateDir: '.agent-state',
    plansDir: 'tests/plans',
    scenariosDir: 'testing/scenarios',
    abs: (rel) => path.join(root, rel),
    tickets: { dir: '.agent-state/board', repo: REPO, assetsBranch: 'board-assets', legacyDir: 'legacy', spikeEpic: { key: 'epic-targeted-advertising', title: 'Targeted Advertising' } },
    board: { storyLabel: 'story', epicLabel: 'epic', spikeLabel: 'spike', columns: { ready: 'Ready', backlog: 'Backlog' } },
  };
  return { base, root, origin, config };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255]);
const story = (key, title, extra = '') => `# ${key}: ${title}\n\n**Part of:** [Promos](../epic-promos.md)\n${extra}\n**User Story:**\n\nAs a shopper, I want ${title.toLowerCase()}.\n\n**Acceptance Criteria:**\n\n- **Given** a cart **When** I pay **Then** it works\n`;
const LEGACY = {
  'epic-promos.md': '# Epic: Promotions\n\n## Summary\n\nPROMO-1 and PROMO-2.\n',
  'stories/PROMO-1-scaffold.md': story('PROMO-1', 'Scaffold'),
  'stories/PROMO-2-admin.md': story('PROMO-2', 'Admin', '* **Blocked by:** [PROMO-1](PROMO-1-scaffold.md)\n'),
  'stories/BUG-3-crash.md': '# BUG-3: [FE - WebApp] - Crash\r\n\r\n**Type:** Bug\r\n\r\nIt crashes.\r\n',
  'mockups/PROMO-2-admin/README.md': '# Admin mockup\n\nScreens.\n',
  'mockups/PROMO-2-admin/Main.dc.html': '<html>main</html>\n',
  'mockups/PROMO-2-admin/shot.png': PNG,
  'mockups/epic-promos-overview/flow.png': PNG,
  'mockups/NOPE-9-orphan/x.html': '<html></html>',
  'research/targeted-ads.md': '# Targeted ads research\n\nFindings.\n\n![Funnel](images/funnel.png)\n',
  'research/images/funnel.png': PNG,
  'research/raw-notes.txt': 'notes',
  'README.md': '# Product research\n',
  '.DS_Store': 'x',
};

describe('issue body format', () => {
  const cases = [
    ['story', { key: 'PROMO-1', type: 'story', title: 'PROMO-1: Scaffold', slug: 'PROMO-1-scaffold', source: 'stories/PROMO-1-scaffold.md' }, story('PROMO-1', 'Scaffold')],
    ['bug (CRLF)', { key: 'BUG-3', type: 'bug', title: 'BUG-3: Crash' }, LEGACY['stories/BUG-3-crash.md']],
    ['epic (no final newline)', { key: 'epic-promos', type: 'epic', title: 'Epic: Promotions' }, '# Epic: Promotions\n\n```js\nconst a = `-->`;\n```'],
    ['spike (BOM, unicode, blank lines at the end)', { key: 'spike-ads', type: 'spike', title: 'Spike: Ads', parent: 'epic-targeted-advertising' }, '﻿# Ads — “research”\n\n| a | b |\n| --- | --- |\n\n\n'],
    ['empty', { key: 'X-1', type: 'story', title: 'X-1' }, ''],
  ];
  for (const [name, ticket, text] of cases) {
    it(`round-trips a ${name} byte for byte`, () => {
      const { body, spilled, meta } = renderBody(ticket, text, { footer: 'footer text' });
      assert.equal(spilled, false);
      const parsed = parseBody(body);
      assert.equal(parsed.content, text);
      assert.equal(parsed.edited, false);
      assert.deepEqual(parsed.meta, meta);
      assert.equal(meta.sourceHash, sha256(Buffer.from(text, 'utf8')));
      // GitHub web edits store CRLF: the content still comes back exactly.
      assert.equal(parseBody(body.replace(/\n/g, '\r\n')).content, text);
    });
  }

  it('keeps the metadata hidden and the header human-readable', () => {
    const { body } = renderBody({ key: 'PROMO-2', type: 'story', title: 'PROMO-2: Admin', parent: 'epic-promos', blockedBy: ['PROMO-1'] }, story('PROMO-2', 'Admin'), { links: { 'epic-promos': 7, 'PROMO-1': 3 } });
    assert.match(body, /^<!-- board-ticket:v1\n\{.*\}\n-->\n> \*\*PROMO-2\*\* · Story · part of #7 · blocked by #3/);
    assert.ok(body.includes(`${BEGIN}\n# PROMO-2: Admin`) && body.includes(`\n${END}`));
  });

  it('detects an edit made on GitHub and returns the edited text', () => {
    const { body } = renderBody({ key: 'PROMO-1', type: 'story' }, 'one\n');
    const parsed = parseBody(body.replace('one', 'two'));
    assert.equal(parsed.content, 'two\n');
    assert.equal(parsed.edited, true);
  });

  it('spills a source over the body limit (or with mixed line endings) to an asset', () => {
    const big = `# BIG-1: Big\n\n${'x'.repeat(BODY_LIMIT)}\n`;
    const r = renderBody({ key: 'BIG-1', type: 'story', source: 'stories/BIG-1-big.md' }, big, { assets: { repo: REPO, commit: 'c'.repeat(40), files: [] } });
    assert.equal(r.spilled, true);
    assert.ok(r.body.length <= BODY_LIMIT);
    assert.deepEqual(r.meta.content, { spilled: 'files/BIG-1/BIG-1-big.md' });
    assert.match(r.body, /blob\/c{40}\/files\/BIG-1\/BIG-1-big\.md/);
    const parsed = parseBody(r.body);
    assert.equal(parsed.content, null);
    assert.equal(parsed.spilled, 'files/BIG-1/BIG-1-big.md');
    assert.equal(renderBody({ key: 'M-1', type: 'story' }, 'a\r\nb\n').spilled, true, 'mixed line endings');
    assert.equal(renderBody({ key: 'M-2', type: 'story' }, `a ${END}\n`).spilled, true, 'a marker in the text');
  });

  it('reads a pre-migration body as legacy', () => {
    assert.equal(parseBody('**Story file:** x\n\nAssign this issue...\n\n---\n\nbody').legacy, true);
  });
});

describe('assets branch', () => {
  it('commits assets with plumbing, pins bodies to the commit, and is idempotent', () => {
    const { root, config } = checkout();
    const head = git(root, 'rev-parse', 'HEAD');
    const status = git(root, 'status', '--porcelain');
    const files = [{ path: 'mockups/PROMO-2/PROMO-2-admin/shot.png', data: PNG }, { path: 'mockups/PROMO-2/PROMO-2-admin/Main.dc.html', data: Buffer.from('<html/>') }];
    const first = buildAssetsCommit(config, files);
    assert.equal(first.changed, true);
    assert.equal(git(root, 'rev-parse', 'refs/heads/board-assets'), first.commit);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'the checked-out branch is untouched');
    assert.equal(git(root, 'status', '--porcelain'), status, 'the working tree is untouched');
    assert.equal(git(root, 'rev-list', '--max-parents=0', 'board-assets'), first.commit, 'an orphan branch');
    assert.equal(buildAssetsCommit(config, files).changed, false, 'same files, same commit');

    const manifest = { repo: REPO, commit: first.commit, files: [{ path: files[0].path, name: 'PROMO-2-admin/shot.png', kind: 'mockup', sha256: sha256(PNG), size: PNG.length }] };
    const { body } = renderBody({ key: 'PROMO-2', type: 'story' }, '# PROMO-2\n', { assets: manifest });
    assert.match(body, new RegExp(`!\\[shot\\.png\\]\\(https://github\\.com/acme/shop/blob/${first.commit}/mockups/PROMO-2/PROMO-2-admin/shot\\.png\\?raw=true\\)`));
    assert.deepEqual(parseBody(body).meta.assets, manifest);

    const dir = path.join(root, 'dl');
    assert.equal(downloadAssets(config, manifest, dir), 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'PROMO-2-admin/shot.png')), PNG);
    assert.equal(downloadAssets(config, manifest, dir), 0, 'a file with the right hash is kept');
    assert.throws(() => downloadAssets(config, { ...manifest, files: [{ ...manifest.files[0], sha256: 'f'.repeat(64) }] }, path.join(root, 'dl2')), /has sha256/);
  });

  it('downloads from a fresh clone by fetching the assets branch', () => {
    const { base, origin, config } = checkout();
    const built = buildAssetsCommit(config, [{ path: 'files/X-1/a.bin', data: PNG }]);
    git(config.root, 'push', '-q', 'origin', 'refs/heads/board-assets:refs/heads/board-assets');
    const clone = path.join(base, 'clone');
    git(base, 'clone', '-q', origin, clone);
    assert.deepEqual(readAsset({ ...config, root: clone }, built.commit, 'files/X-1/a.bin', { gh: () => ({ status: 1, stdout: '', stderr: 'no gh' }) }), PNG);
  });
});

describe('fetch and the cache', () => {
  const setup = () => {
    const c = checkout();
    const hub = fakeGitHub(REPO);
    const text = story('PROMO-1', 'Scaffold');
    const { body } = renderBody({ key: 'PROMO-1', type: 'story', title: 'PROMO-1: Scaffold', slug: 'PROMO-1-scaffold', parent: 'epic-promos' }, text);
    const number = hub.add({ title: 'PROMO-1: Scaffold', body, labels: ['story'] });
    return { ...c, hub, text, number };
  };

  it('writes story.md and meta.json, skips an unchanged issue, refetches a changed one', () => {
    const { config, hub, text, number } = setup();
    assert.deepEqual(fetchTickets(config, ['PROMO-1'], { gh: hub.gh }).map((r) => r.status), ['fetched']);
    assert.equal(fs.readFileSync(ticketFile(config, 'PROMO-1'), 'utf8'), text);
    const meta = readMeta(config, 'PROMO-1');
    assert.deepEqual([meta.key, meta.slug, meta.parent, meta.issue.number], ['PROMO-1', 'PROMO-1-scaffold', 'epic-promos', number]);
    const views = () => hub.calls.filter((c) => c[1] === 'view').length;
    const before = views();
    assert.deepEqual(fetchTickets(config, ['PROMO-1'], { gh: hub.gh }).map((r) => r.status), ['unchanged']);
    assert.equal(views(), before, 'an unchanged issue is not downloaded');

    const edited = `${text}\n- **Given** a coupon **When** I pay **Then** it is applied\n`;
    hub.edit(number, renderBody({ key: 'PROMO-1', type: 'story', slug: 'PROMO-1-scaffold' }, edited).body);
    assert.deepEqual(fetchTickets(config, ['PROMO-1'], { gh: hub.gh }).map((r) => r.status), ['fetched']);
    assert.equal(fs.readFileSync(ticketFile(config, 'PROMO-1'), 'utf8'), edited);
  });

  it('uses the cache with a warning when GitHub is unreachable, and errors clearly otherwise', () => {
    const { config, hub } = setup();
    fetchTickets(config, ['PROMO-1'], { gh: hub.gh });
    hub.offline = true;
    const warnings = [];
    const [cached, uncached] = fetchTickets(config, ['PROMO-1', 'PROMO-2'], { gh: hub.gh, log: (m) => warnings.push(m) });
    assert.equal(cached.status, 'offline-cache');
    assert.match(warnings.join('\n'), /GitHub unreachable.*using the cached PROMO-1/);
    assert.equal(uncached.status, 'error');
    assert.match(uncached.message, /cannot reach GitHub to fetch PROMO-2 and it is not cached/);
    hub.offline = false;
    const [missing] = fetchTickets(config, ['PROMO-404'], { gh: hub.gh });
    assert.equal(missing.status, 'missing');
    assert.match(missing.message, /PROMO-404 has no issue on acme\/shop/);
  });

  it('never overwrites unpublished local edits silently', () => {
    const { config, hub, number, text } = setup();
    fetchTickets(config, ['PROMO-1'], { gh: hub.gh });
    fs.appendFileSync(ticketFile(config, 'PROMO-1'), '\n## Implementation Notes\n');
    hub.edit(number, renderBody({ key: 'PROMO-1', type: 'story' }, `${text}more\n`).body);
    assert.equal(fetchTickets(config, ['PROMO-1'], { gh: hub.gh, log: () => {} })[0].status, 'conflict');
    assert.match(fs.readFileSync(ticketFile(config, 'PROMO-1'), 'utf8'), /Implementation Notes/);
    assert.equal(fetchTickets(config, ['PROMO-1'], { gh: hub.gh, refresh: true })[0].status, 'fetched');
  });

  it("finds an older story version in the cache history or the issue's edit history, for plan updates", () => {
    const { config, hub, number, text } = setup();
    fetchTickets(config, ['PROMO-1'], { gh: hub.gh });
    const oldSha = readMeta(config, 'PROMO-1').storySha;
    const changed = `${text}- **Given** an expired coupon **When** I pay **Then** 400\n`;
    hub.edit(number, renderBody({ key: 'PROMO-1', type: 'story', slug: 'PROMO-1-scaffold' }, changed).body);
    fetchTickets(config, ['PROMO-1'], { gh: hub.gh });
    const diff = storyDiffSince(config, { key: 'PROMO-1', file: '.agent-state/board/PROMO-1/story.md' }, oldSha);
    assert.match(diff, /\+- \*\*Given\*\* an expired coupon/);
    fs.rmSync(path.join(config.root, '.agent-state/board/PROMO-1/history'), { recursive: true });
    fs.mkdirSync(path.join(config.root, '.agent-state/board/PROMO-1/history'));
    const fromGitHub = storyVersion(config, 'PROMO-1', oldSha, { gh: hub.gh });
    assert.equal(fromGitHub, null, 'the board is not reachable from a fixture checkout');
  });
});

describe('the loader', () => {
  const seed = (config, key, text, extra = {}) => writeTicket(config, key, { content: text, meta: metaFor({ key, type: 'story', title: key, slug: `${key}-x`, blockedBy: [], ...extra }, text) });

  it('resolves keys, slugs and paths from the cache, lists an epic in Blocked-by order, and finds mockups', () => {
    resetTicketMemo();
    const { config } = checkout();
    seed(config, 'epic-promos', '# Epic: Promos\n', { type: 'epic', title: 'Epic: Promos' });
    seed(config, 'PROMO-3', '# PROMO-3\n', { parent: 'epic-promos', blockedBy: ['PROMO-5', 'PROMO-1'] });
    seed(config, 'PROMO-5', '# PROMO-5\n', { parent: 'epic-promos', blockedBy: ['PROMO-1'] });
    seed(config, 'PROMO-1', '# PROMO-1\n', { parent: 'epic-promos' });
    seed(config, 'OTHER-1', '# OTHER-1\n');
    write(config.root, '.agent-state/board/PROMO-3/mockups/PROMO-3-cart/Main.png', 'png');

    assert.deepEqual(epicTickets(config, 'promos').map((s) => s.key), ['PROMO-1', 'PROMO-5', 'PROMO-3']);
    assert.deepEqual(listStories(config).map((s) => s.key), ['OTHER-1', 'PROMO-1', 'PROMO-3', 'PROMO-5']);
    for (const arg of ['PROMO-3', 'promo-3', 'PROMO-3-x', '.agent-state/board/PROMO-3/story.md', 'feat/promo-3-cart']) assert.equal(resolveStory(config, arg)?.key, 'PROMO-3', arg);
    assert.equal(resolveStory(config, 'epic-promos'), null, 'epics are not stories');
    const s = resolveStory(config, 'PROMO-3');
    assert.deepEqual([s.file, s.planDir, s.scenario, s.epic], ['.agent-state/board/PROMO-3/story.md', 'tests/plans/PROMO-3-x', 'promo-3', 'epic-promos']);
    assert.deepEqual(mockupFiles(config, 'PROMO-3'), ['.agent-state/board/PROMO-3/mockups/PROMO-3-cart/Main.png']);
    assert.deepEqual([...listEpics(config)[0].stories].sort(), ['PROMO-1', 'PROMO-3', 'PROMO-5']);
    assert.equal(loadTicket(config, 'PROMO-404'), null, 'unknown and the board is not reachable');
    assert.deepEqual([...keysFromPaths(config, ['tests/plans/PROMO-3-x/_index.md', 'testing/scenarios/promo-5/seed.json', 'src/a.cs', '.agent-state/board/OTHER-1/story.md'])].sort(), ['OTHER-1', 'PROMO-3', 'PROMO-5']);
    assert.equal(keyOfArg('spike-ads'), 'spike-ads');
    assert.throws(() => orderByBlockers([{ key: 'A-1', blockedBy: ['A-2'] }, { key: 'A-2', blockedBy: ['A-1'] }]), /Dependency cycle/);
  });

  it('works with the legacy folder absent, and imports from it while it exists', () => {
    resetTicketMemo();
    const absent = checkout();
    assert.equal(resolveStory(absent.config, 'PROMO-1'), null);
    assert.deepEqual(listStories(absent.config), []);
    resetTicketMemo();
    const present = checkout({ legacy: LEGACY });
    const s = resolveStory(present.config, 'PROMO-2');
    assert.equal(fs.readFileSync(path.join(present.root, s.file), 'utf8'), LEGACY['stories/PROMO-2-admin.md']);
    assert.deepEqual([s.slug, s.epic, s.blockedBy], ['PROMO-2-admin', 'epic-promos', ['PROMO-1']]);
    assert.deepEqual(mockupFiles(present.config, 'PROMO-2'), ['README.md', 'Main.dc.html', 'shot.png'].map((f) => `.agent-state/board/PROMO-2/mockups/PROMO-2-admin/${f}`).sort());
  });
});

describe('migration', () => {
  it('classifies every file: stories, bugs, epics, a research spike under a new epic, assets, ignored, unplaced', () => {
    const { config } = checkout({ legacy: LEGACY });
    const legacy = classifyLegacy(config);
    const byKey = Object.fromEntries(legacy.tickets.map((t) => [t.key, t]));
    assert.deepEqual(legacy.tickets.map((t) => [t.key, t.type]).sort(), [
      ['BUG-3', 'bug'],
      ['PROMO-1', 'story'],
      ['PROMO-2', 'story'],
      ['epic-promos', 'epic'],
      ['epic-targeted-advertising', 'epic'],
      ['spike-targeted-ads', 'spike'],
    ]);
    assert.equal(byKey['spike-targeted-ads'].parent, 'epic-targeted-advertising');
    assert.equal(byKey['epic-targeted-advertising'].generated, true);
    assert.match(byKey['epic-targeted-advertising'].text, /# Epic: Targeted Advertising[\s\S]*Targeted ads research \(`spike-targeted-ads`\)/);
    assert.deepEqual(byKey['PROMO-2'].assets.map((a) => a.path), ['mockups/PROMO-2/PROMO-2-admin/Main.dc.html', 'mockups/PROMO-2/PROMO-2-admin/README.md', 'mockups/PROMO-2/PROMO-2-admin/shot.png']);
    assert.deepEqual(byKey['epic-promos'].assets.map((a) => a.path), ['mockups/epic-promos/epic-promos-overview/flow.png']);
    assert.deepEqual(byKey['spike-targeted-ads'].assets.map((a) => [a.path, a.source]), [
      ['files/spike-targeted-ads/images/funnel.png', 'research/images/funnel.png'],
      ['files/spike-targeted-ads/raw-notes.txt', 'research/raw-notes.txt'],
    ]);
    assert.deepEqual(legacy.ignored, ['.DS_Store']);
    assert.deepEqual(legacy.unplaced.map((u) => u.source).sort(), ['README.md', 'mockups/NOPE-9-orphan/x.html']);

    const hub = fakeGitHub(REPO);
    hub.add({ title: 'PROMO-1: Scaffold', body: 'old', labels: ['story'] });
    const plan = planMigration(config, { gh: hub.gh });
    assert.deepEqual(plan.counts.byType, { story: 2, bug: 1, epic: 2, spike: 1 });
    assert.deepEqual([plan.counts.files, plan.counts.existingIssues, plan.counts.issuesToCreate, plan.counts.unplaced, plan.counts.ignored], [14, 1, 5, 2, 1]);
    assert.equal(plan.entries.length, 14, 'every file has an entry');
    assert.equal(plan.entries.find((e) => e.source === 'stories/PROMO-1-scaffold.md').issue, 1);
    assert.equal(hub.writes, 0, 'the dry run writes nothing');
  });

  it('applies idempotently, verifies against GitHub, catches differences, and guards delete-local', () => {
    const { root, config } = checkout({ legacy: { ...LEGACY, 'README.md': undefined, 'mockups/NOPE-9-orphan/x.html': undefined } });
    // References that delete-local must drop.
    write(root, '.graphifyignore', 'deploy/\n# Legacy stories (removed by board migrate --delete-local)\nlegacy/\n');
    write(root, 'ci.yml', "paths:\n  - 'legacy/**'\n  - 'src/**'\n");
    write(root, 'pipeline.json', `${JSON.stringify({ tickets: { dir: '.agent-state/board', legacyDir: 'legacy' }, storyGuard: { folders: ['.agent-state/board', 'legacy'] } }, null, 2)}\n`);
    write(root, 'tests/plans/PROMO-1-scaffold/_index.md', '---\nstory: PROMO-1\nstory-file: legacy/stories/PROMO-1-scaffold.md\n---\n# plan\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'refs');
    const hub = fakeGitHub(REPO);
    hub.add({ title: 'PROMO-1: Scaffold', body: '**Story file:** old body', labels: ['story'] });

    assert.match(deleteLocal(config).reason, /no verify report/);
    const first = applyMigration(config, { gh: hub.gh });
    assert.deepEqual([first.created.length, first.updated, first.linked], [5, ['PROMO-1'], 3]);
    assert.ok(git(root, 'ls-remote', 'origin', 'refs/heads/board-assets').startsWith(first.commit), 'apply pushes the assets branch');
    const writes = hub.writes;
    const again = applyMigration(config, { gh: hub.gh });
    assert.deepEqual([again.created.length, again.updated.length, again.linked, again.commit], [0, 0, 0, first.commit]);
    assert.equal(hub.writes, writes, 'a second apply writes nothing');
    const spike = [...hub.issues.values()].find((i) => i.title === 'Spike: Targeted ads research');
    const epic = [...hub.issues.values()].find((i) => i.title === 'Epic: Targeted Advertising');
    assert.deepEqual([spike.labels, epic.labels, spike.parent], [['spike'], ['epic'], epic.number]);
    assert.match(spike.body, new RegExp(`!\\[funnel\\.png\\]\\(https://github\\.com/acme/shop/blob/${first.commit}/files/spike-targeted-ads/images/funnel\\.png\\?raw=true\\)`));

    const ok = verifyMigration(config, { gh: hub.gh });
    assert.equal(ok.passed, true, JSON.stringify(ok.differences));
    assert.ok(fs.existsSync(path.join(root, '.agent-state/board/migration-report.md')));

    // A difference on GitHub fails the verify, and a failed verify blocks delete-local.
    const promo2 = [...hub.issues.values()].find((i) => i.title.startsWith('PROMO-2'));
    const original = promo2.body;
    hub.edit(promo2.number, original.replace('As a shopper', 'As a robot'));
    const bad = verifyMigration(config, { gh: hub.gh });
    assert.equal(bad.passed, false);
    assert.deepEqual(bad.differences.map((d) => [d.key, d.what]), [['PROMO-2', 'content']]);
    assert.match(deleteLocal(config).reason, /failed with 1 difference/);
    hub.edit(promo2.number, original);
    assert.equal(verifyMigration(config, { gh: hub.gh }).passed, true);

    // Files that changed after the verify block delete-local too.
    fs.appendFileSync(path.join(root, 'legacy/mockups/PROMO-2-admin/README.md'), 'new\n');
    assert.match(deleteLocal(config).reason, /files changed since the last verify/);
    assert.equal(verifyMigration(config, { gh: hub.gh }).passed, false, 'the changed asset is not on the board yet');
    applyMigration(config, { gh: hub.gh });
    assert.equal(verifyMigration(config, { gh: hub.gh }).passed, true);

    const r = deleteLocal(config);
    assert.equal(r.ok, true, r.reason);
    assert.equal(fs.existsSync(path.join(root, 'legacy')), false);
    assert.equal(fs.readFileSync(path.join(root, '.graphifyignore'), 'utf8'), 'deploy/\n');
    assert.equal(fs.readFileSync(path.join(root, 'ci.yml'), 'utf8'), "paths:\n  - 'src/**'\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'pipeline.json'), 'utf8')), { tickets: { dir: '.agent-state/board' }, storyGuard: { folders: ['.agent-state/board'] } });
    assert.match(fs.readFileSync(path.join(root, 'tests/plans/PROMO-1-scaffold/_index.md'), 'utf8'), /^story-issue: https:\/\/github\.com\/acme\/shop\/issues\/1$/m);
    assert.deepEqual(r.remaining, []);
    assert.match(git(root, 'status', '--porcelain'), /D {2}legacy\/stories\/PROMO-1-scaffold\.md/);

    // With the folder gone the loader still works from the board.
    resetTicketMemo();
    const gone = { ...config, tickets: { ...config.tickets, legacyDir: undefined } };
    assert.deepEqual(fetchTickets(gone, ['PROMO-2'], { gh: hub.gh, refresh: true }).map((x) => x.status), ['fetched']);
    assert.equal(resolveStory(gone, 'PROMO-2').title, 'PROMO-2: Admin');
    assert.ok(fs.existsSync(path.join(root, '.agent-state/board/PROMO-2/mockups/PROMO-2-admin/shot.png')));
  });
});
