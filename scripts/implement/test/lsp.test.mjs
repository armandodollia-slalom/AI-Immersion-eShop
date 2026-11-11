// The language-server adapter against a fake lspd, and `implement cleanup` stopping daemons.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSubtaskWorktree } from '../lib/gitops.mjs';
import { callsFile, formatDiagnostics, lspAdapter, signatureChanges } from '../lib/lsp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fake = path.join(here, 'fixtures', 'fake-lspd.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-')));
const logFile = path.join(tmp, 'lspd.log');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sh = (cwd, cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function repo(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'src/Catalog.API'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/Catalog.API/Api.cs'), '// api\n');
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['config', 'user.email', 't@e.com']);
  sh(root, 'git', ['config', 'user.name', 'T']);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'init']);
  return root;
}

const config = (root, lsp) => ({ root, implement: { lsp: { enabled: true, lspdCmd: [process.execPath, fake], slnfCmd: [process.execPath, fake], timeoutSec: 30, ...lsp } } });

test('missing tooling disables the adapter; every call degrades to no information', async () => {
  const root = repo('missing');
  const lsp = lspAdapter({ root, implement: { lsp: { lspdCmd: ['node', 'scripts/lsp/nope.mjs'] } } }, { mainRoot: root });
  assert.equal(lsp.enabled, false);
  assert.deepEqual(await lsp.start(root), { ok: false, csharp: 'unavailable', reason: 'lsp tooling not installed' });
  assert.deepEqual(await lsp.diagnostics(root, ['src/Catalog.API/Api.cs']), { available: false, errors: [], warnings: [] });
});

test('start writes a solution filter from owns; diagnostics split errors and warnings; stop', async () => {
  const root = repo('daemon');
  process.env.FAKE_LSPD_LOG = logFile;
  process.env.FAKE_LSPD_DIAG = JSON.stringify({ files: { 'src/Catalog.API/Api.cs': [{ severity: 'error', line: 3, col: 5, code: 'CS1002', message: '; expected' }, { severity: 'warning', line: 1, col: 1, code: 'CS0168', message: 'unused' }, { severity: 'info', line: 1, message: 'x' }], 'web/app.ts': 'unavailable' } });
  try {
    const lsp = lspAdapter(config(root), { mainRoot: root });
    const started = await lsp.start(root, { owns: ['src/Catalog.API/**'] });
    assert.equal(started.csharp, 'running');
    assert.ok(lsp.csharpRunning(root));
    const [slnfCall, startCall] = logged();
    assert.deepEqual(slnfCall.slice(0, 2), ['--owns', 'src/Catalog.API/**']);
    assert.match(slnfCall.at(-1), /\.git\/lsp\/subtask\.slnf$/, 'the filter lives in the git dir, untracked');
    assert.deepEqual(startCall.slice(0, 3), ['start', '--worktree', root]);
    assert.equal(startCall[4], slnfCall.at(-1));
    const diag = await lsp.diagnostics(root, ['src/Catalog.API/Api.cs', 'deleted.cs']);
    assert.equal(logged().at(-1).filter((a) => a === 'deleted.cs').length, 0, 'deleted files are not asked about');
    assert.deepEqual(diag.errors, [{ file: 'src/Catalog.API/Api.cs', line: 3, col: 5, code: 'CS1002', message: '; expected' }]);
    assert.equal(diag.warnings.length, 1);
    assert.match(formatDiagnostics(diag), /error src\/Catalog\.API\/Api\.cs:3:5 CS1002: ; expected\n- warning/);
    await lsp.stop(root);
    assert.deepEqual(logged().at(-1), ['stop', '--worktree', root]);
    assert.ok(!lsp.csharpRunning(root));
  } finally {
    delete process.env.FAKE_LSPD_DIAG;
  }
});

test('LSP calls are counted per agent and time window from the worktree call log', () => {
  const root = repo('calls');
  const lsp = lspAdapter(config(root), { mainRoot: root });
  const file = callsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = Date.now();
  const rec = (agent, tool, at) => JSON.stringify({ ts: new Date(at).toISOString(), agent, tool, file: 'a.cs', symbol: 'X' });
  fs.writeFileSync(file, [rec('pair-implementer', 'mcp__csharp__find_references', t), rec('pair-implementer', 'mcp__csharp__definition', t), rec('pair-verifier', 'mcp__csharp__hover', t), rec('pair-implementer', 'mcp__csharp__hover', t - 60_000)].join('\n') + '\n');
  const calls = lsp.calls(root, 'pair-implementer', t - 5000, t + 5000);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((c) => lsp.isReferences(c.tool)).length, 1);
});

test('signature changes are found in a diff', () => {
  const diff = ['--- a/x.cs', '+++ b/x.cs', '-    public int Total(Basket b)', '+    public decimal Total(Basket b, Coupon? c)', '+    private void Helper()', '+    public string Name { get; set; }', '+    [HttpGet] internal static Task<IResult> Get(int id) =>'].join('\n');
  assert.deepEqual(signatureChanges(diff), ['public int Total(Basket b)', 'public decimal Total(Basket b, Coupon? c)', '[HttpGet] internal static Task<IResult> Get(int id) =>']);
});

test('implement cleanup stops the daemon of each subtask worktree before removing it', () => {
  const root = repo('cleanup-shop');
  for (const dir of ['scripts/pipeline', 'scripts/implement', 'scripts/review', 'scripts/qe', 'scripts/board', 'scripts/models', 'scripts/pr-video']) fs.cpSync(path.join(source, dir), path.join(root, dir), { recursive: true, filter: (p) => !p.includes(`${path.sep}test`) });
  fs.mkdirSync(path.join(root, 'scripts/lsp'), { recursive: true });
  fs.copyFileSync(fake, path.join(root, 'scripts/lsp/lspd.mjs'));
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'scripts']);
  sh(root, 'git', ['checkout', '-qb', 'feat/demo-1-x']);
  const story = path.join(tmp, 'cleanup-wt', 'demo-1');
  fs.mkdirSync(path.dirname(story), { recursive: true });
  sh(root, 'git', ['worktree', 'add', '-q', story, '-b', 'feat/demo-1-story']);
  const wt = createSubtaskWorktree(story, { prefix: 'feat/', key: 'DEMO-1', id: 'api' });
  fs.rmSync(logFile, { force: true });
  const env = { ...process.env, FAKE_LSPD_LOG: logFile };
  delete env.PIPELINE_ROOT;
  const status = sh(root, process.execPath, ['scripts/implement/implement.mjs', 'status'], env);
  assert.match(status, /Subtask worktrees still on disk[\s\S]*DEMO-1 +api +.*demo-1--api/);
  const out = sh(root, process.execPath, ['scripts/implement/implement.mjs', 'cleanup', 'DEMO-1'], env);
  assert.match(out, /removed .*demo-1--api \(feat\/demo-1--api\)/);
  assert.deepEqual(logged(), [['stop', '--worktree', wt.path]]);
  assert.ok(!fs.existsSync(wt.path));
  assert.equal(sh(root, 'git', ['branch', '--list', 'feat/demo-1--api']), '');
});
