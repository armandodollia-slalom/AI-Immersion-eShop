// PR demo videos: spec selection, the managed PR section, and publishing to the storage branch,
// against throwaway git repos (no GitHub access).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { rawGitHubUrl, videoLinks } from '../../pr-check/lib/github.mjs';
import { changedSpecs, publishFolder, recordedTests, renderSection, upsertSection } from '../lib/pr-video.mjs';

const temps = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-test-'));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const initRepo = (dir, bare = false) => {
  sh(dir, 'init', '-q', ...(bare ? ['--bare'] : []), '-b', 'main');
  if (!bare) {
    sh(dir, 'config', 'user.email', 't@example.com');
    sh(dir, 'config', 'user.name', 'Test');
  }
  return dir;
};
const write = (root, rel, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

test('changedSpecs lists only teststack specs added or changed on the branch, not deleted ones', () => {
  const repo = initRepo(tmp());
  write(repo, 'e2e/teststack/old.spec.ts');
  write(repo, 'e2e/teststack/gone.spec.ts');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'e2e/teststack/old.spec.ts', 'changed');
  write(repo, 'e2e/teststack/new.spec.ts');
  write(repo, 'e2e/teststack/helpers.ts');
  write(repo, 'e2e/CartTest.spec.ts');
  fs.rmSync(path.join(repo, 'e2e/teststack/gone.spec.ts'));
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'feature');
  assert.deepEqual(changedSpecs(repo, 'main').sort(), ['e2e/teststack/new.spec.ts', 'e2e/teststack/old.spec.ts']);
});

test('upsertSection appends the section once and replaces it on later runs, keeping the rest of the body', () => {
  const first = upsertSection('Implements PROMO-3.', 'one');
  assert.match(first, /^Implements PROMO-3\.\n\n<!-- pr-demo-video:start -->\none\n<!-- pr-demo-video:end -->\n$/);
  const second = upsertSection(`${first}\nFooter`, 'two');
  assert.equal(second, 'Implements PROMO-3.\n\n<!-- pr-demo-video:start -->\ntwo\n<!-- pr-demo-video:end -->\n\nFooter');
  assert.equal(upsertSection('', 'only'), '<!-- pr-demo-video:start -->\nonly\n<!-- pr-demo-video:end -->\n');
});

test('recordedTests keeps the last attempt of each test that kept a video', () => {
  const t = (retry, ok, videos) => ({ project: 'scenarios', file: 'e2e/teststack/a.spec.ts', titlePath: ['scenarios', 'a.spec.ts', 'adds'], title: 'adds', retry, ok, videos });
  const api = { ...t(0, true, []), title: 'api', titlePath: ['scenarios', 'a.spec.ts', 'api'] };
  const tests = recordedTests({ tests: [t(0, false, ['a.failed.webm']), t(1, true, ['a.webm']), api] });
  assert.deepEqual(tests.map((x) => [x.retry, x.videos]), [[1, ['a.webm']]]);
});

test('the rendered section links each video so the PR check can download it', () => {
  const section = renderSection({
    repo: 'o/r',
    branch: 'pr-videos',
    pr: 7,
    headSha: 'abcdef1234',
    specs: ['e2e/teststack/a.spec.ts'],
    videos: [{ title: 'adds › to cart', file: 'e2e/teststack/a.spec.ts', ok: true, video: 'a--adds.webm', preview: 'a--adds.gif' }],
  });
  assert.match(section, /commit abcdef1/);
  assert.match(section, /\[!\[adds › to cart\]\(https:\/\/github\.com\/o\/r\/blob\/pr-videos\/pr-7\/a--adds\.gif\?raw=true\)\]/);
  const links = videoLinks(section, ['.webm', '.mp4']);
  assert.deepEqual(links, ['https://github.com/o/r/blob/pr-videos/pr-7/a--adds.webm']);
  assert.equal(rawGitHubUrl(links[0]), 'https://raw.githubusercontent.com/o/r/pr-videos/pr-7/a--adds.webm');
  assert.equal(rawGitHubUrl('https://example.com/a.webm'), 'https://example.com/a.webm');
});

test('publishFolder keeps one parentless commit with every PR folder, replacing and removing one PR', () => {
  const remote = initRepo(tmp(), true);
  const repo = initRepo(tmp());
  sh(repo, 'remote', 'add', 'origin', remote);
  const stage = (files) => {
    const dir = tmp();
    for (const [name, text] of Object.entries(files)) write(dir, name, text);
    return dir;
  };
  const files = () => sh(repo, `--git-dir=${remote}`, 'ls-tree', '-r', '--name-only', 'pr-videos').split('\n').filter(Boolean);

  assert.equal(publishFolder(repo, { branch: 'pr-videos', folder: 'pr-1', stageDir: stage({ 'a.webm': '1' }), message: 'm' }).pushed, true);
  publishFolder(repo, { branch: 'pr-videos', folder: 'pr-2', stageDir: stage({ 'b.webm': '2' }), message: 'm' });
  publishFolder(repo, { branch: 'pr-videos', folder: 'pr-1', stageDir: stage({ 'c.webm': '3', 'c.gif': '4' }), message: 'm' });
  assert.deepEqual(files(), ['pr-1/c.gif', 'pr-1/c.webm', 'pr-2/b.webm']);
  assert.equal(sh(repo, `--git-dir=${remote}`, 'rev-list', '--count', 'pr-videos'), '1');

  publishFolder(repo, { branch: 'pr-videos', folder: 'pr-1', stageDir: null, message: 'm' });
  assert.deepEqual(files(), ['pr-2/b.webm']);
  assert.equal(publishFolder(repo, { branch: 'pr-videos', folder: 'pr-9', stageDir: null, message: 'm' }).pushed, false);
});
