import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireLease, control, daemonPaths, listLeases, releaseLease, worktreeHash } from '../lib/common.mjs';
import { generateSlnf, globToRegExp, projectMatches } from '../lib/slnf.mjs';

const LSP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

describe('socket paths', () => {
  test('are derived from the real worktree path and fit a unix socket', () => {
    const dir = tmp('lspd-path-');
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    try {
      assert.match(worktreeHash(dir), /^[0-9a-f]{12}$/);
      assert.equal(worktreeHash(link), worktreeHash(dir));
      const p = daemonPaths(dir);
      assert.equal(path.basename(p.socket), `${p.hash}.sock`);
      assert.ok(Buffer.byteLength(p.socket) < 104, p.socket);
      assert.notEqual(daemonPaths(os.tmpdir()).socket, p.socket);
    } finally {
      fs.rmSync(link);
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('C# lease', () => {
  test('caps holders, denies when full and frees on release', () => {
    const dir = tmp('lspd-lease-');
    const a = acquireLease({ owner: '/wt/a', max: 2, dir });
    const b = acquireLease({ owner: '/wt/b', max: 2, dir, pid: process.ppid });
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.slot, b.slot);
    const c = acquireLease({ owner: '/wt/c', max: 2, dir, pid: process.ppid });
    assert.equal(c.ok, false);
    assert.match(c.reason, /all 2 C# language server slots are in use/);
    releaseLease(a);
    const d = acquireLease({ owner: '/wt/d', max: 2, dir });
    assert.ok(d.ok);
    assert.equal(d.slot, a.slot);
    fs.rmSync(dir, { recursive: true });
  });

  test('is idempotent for the same holder', () => {
    const dir = tmp('lspd-lease-');
    const a = acquireLease({ owner: '/wt/a', max: 1, dir });
    const again = acquireLease({ owner: '/wt/a', max: 1, dir });
    assert.ok(again.ok);
    assert.equal(again.slot, a.slot);
    fs.rmSync(dir, { recursive: true });
  });

  test('reclaims a slot whose holder died', () => {
    const dir = tmp('lspd-lease-');
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify({ slot: 0, pid: deadPid(), owner: '/wt/gone' }));
    assert.equal(listLeases(dir)[0].alive, false);
    const l = acquireLease({ owner: '/wt/new', max: 1, dir });
    assert.ok(l.ok);
    assert.equal(JSON.parse(fs.readFileSync(l.file, 'utf8')).owner, '/wt/new');
    fs.rmSync(dir, { recursive: true });
  });

  test('never reclaims a slot that is still being written', () => {
    const dir = tmp('lspd-lease-');
    fs.writeFileSync(path.join(dir, 'slot-0.json'), '');
    assert.equal(acquireLease({ owner: '/wt/x', max: 1, dir }).ok, false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('solution filter', () => {
  let root;
  before(() => {
    root = tmp('lspd-slnf-');
    const proj = (dir, refs = []) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      const items = refs.map((r) => `    <ProjectReference Include="${r}" />`).join('\n');
      fs.writeFileSync(path.join(root, dir, `${path.basename(dir)}.csproj`), `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${items}\n  </ItemGroup>\n</Project>\n`);
    };
    proj('src/Api', ['..\\Domain\\Domain.csproj', '..\\Infra\\Infra.csproj']);
    proj('src/Infra', ['..\\Domain\\Domain.csproj']);
    proj('src/Domain');
    proj('src/Web', ['../Shared/Shared.csproj']);
    proj('src/Shared');
    proj('tests/Api.Tests', ['..\\..\\src\\Api\\Api.csproj']);
    const projects = ['src/Api/Api.csproj', 'src/Infra/Infra.csproj', 'src/Domain/Domain.csproj', 'src/Web/Web.csproj', 'src/Shared/Shared.csproj', 'tests/Api.Tests/Api.Tests.csproj'];
    fs.writeFileSync(path.join(root, 'eShop.slnx'), `<Solution>\n${projects.map((p) => `  <Project Path="${p}" />`).join('\n')}\n</Solution>\n`);
  });
  after(() => fs.rmSync(root, { recursive: true }));

  test('globs match directories and files inside them', () => {
    assert.ok(globToRegExp('src/Api/**').test('src/Api'));
    assert.ok(globToRegExp('src/**').test('src/Api'));
    assert.ok(globToRegExp('**/Api').test('src/Api'));
    assert.ok(!globToRegExp('src/A*').test('src/Api/x'));
    assert.ok(projectMatches('src/Api', 'src/Api/Controllers/*.cs'));
    assert.ok(projectMatches('src/Api', 'src/Api'));
    assert.ok(!projectMatches('src/Api', 'src/Web/**'));
    assert.ok(!projectMatches('src/Api', 'src/ApiX/**'));
  });

  test('includes the transitive ProjectReference closure', () => {
    const r = generateSlnf({ root, owns: ['src/Api/**'] });
    assert.deepEqual(r.projects, ['src/Api/Api.csproj', 'src/Domain/Domain.csproj', 'src/Infra/Infra.csproj']);
    const both = generateSlnf({ root, owns: ['src/Web/Pages/*.razor', 'tests/Api.Tests/**'] });
    assert.deepEqual(both.projects, ['src/Api/Api.csproj', 'src/Domain/Domain.csproj', 'src/Infra/Infra.csproj', 'src/Shared/Shared.csproj', 'src/Web/Web.csproj', 'tests/Api.Tests/Api.Tests.csproj']);
  });

  test('writes a filter whose paths resolve against the solution', () => {
    const out = path.join(root, 'filters', 'api.slnf');
    const r = generateSlnf({ root, owns: ['src/Infra'], out });
    assert.ok(r.ok);
    const slnf = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(slnf.solution.path, '../eShop.slnx');
    assert.deepEqual(slnf.solution.projects, ['src\\Domain\\Domain.csproj', 'src\\Infra\\Infra.csproj']);
    for (const p of slnf.solution.projects) assert.ok(fs.existsSync(path.join(root, p.replace(/\\/g, '/'))));
  });

  test('fails clearly when nothing matches', () => {
    const r = generateSlnf({ root, owns: ['src/Nope/**'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /no project/);
  });

  test('CLI prints JSON', () => {
    const r = spawnSync(process.execPath, [path.join(LSP_DIR, 'slnf.mjs'), '--root', root, '--owns', 'src/Web/**'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).projects, ['src/Shared/Shared.csproj', 'src/Web/Web.csproj']);
  });
});

describe('lspd daemon', { timeout: 120000 }, () => {
  let worktree;
  let env;
  const lspd = (...args) => {
    const r = spawnSync(process.execPath, [path.join(LSP_DIR, 'lspd.mjs'), ...args], { encoding: 'utf8', env, timeout: 60000 });
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };

  before(() => {
    worktree = tmp('lspd-wt-');
    spawnSync('git', ['init', '-q', worktree]);
    fs.writeFileSync(path.join(worktree, 'eShop.slnx'), '<Solution />\n');
    fs.mkdirSync(path.join(worktree, 'src'));
    fs.writeFileSync(path.join(worktree, 'src/A.cs'), 'class A {}\n');
    const configDir = path.join(worktree, '.lspconfig');
    fs.mkdirSync(configDir);
    const config = JSON.parse(fs.readFileSync(path.join(LSP_DIR, 'config.json'), 'utf8'));
    config.servers = [{ id: 'csharp', extensions: ['.cs'], languageIds: ['csharp'], leased: true, command: process.execPath, args: [path.join(LSP_DIR, 'test/fixtures/fake-lsp.mjs')] }];
    config.restoreSolution = null;
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
    env = { ...process.env, LSP_RUNTIME_DIR: tmp('lspd-rt-'), LSP_CONFIG_DIR: configDir, LSP_MAX_SERVERS: '1' };
  });
  after(() => {
    lspd('stop', '--worktree', worktree);
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(env.LSP_RUNTIME_DIR, { recursive: true, force: true });
  });

  test('start is idempotent and serves MCP calls through the fake server', async () => {
    const first = lspd('start', '--worktree', worktree);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.csharp, 'running');
    const second = lspd('start', '--worktree', worktree);
    assert.equal(second.pid, first.pid);
    assert.equal(second.socket, first.socket);

    process.env.LSP_RUNTIME_DIR = env.LSP_RUNTIME_DIR;
    try {
      let state;
      for (let i = 0; i < 50 && state !== 'ready'; i++) {
        state = (await control(first.socket, { lspd: 'status' })).csharpState;
        if (state !== 'ready') await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(state, 'ready');

      const mcp = spawn(process.execPath, [path.join(LSP_DIR, 'mcp.mjs')], { cwd: worktree, env: { ...env, PIPELINE_AGENT_NAME: 'tester' }, stdio: ['pipe', 'pipe', 'inherit'] });
      const replies = [];
      let buf = '';
      mcp.stdout.on('data', (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          replies.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
      });
      const send = (m) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      send({ id: 2, method: 'tools/list' });
      send({ id: 3, method: 'tools/call', params: { name: 'lsp_hover', arguments: { file_path: path.join(worktree, 'src/A.cs'), line: 1, column: 7 } } });
      send({ id: 4, method: 'tools/call', params: { name: 'lsp_hover', arguments: { file_path: '/elsewhere/B.cs', line: 1, column: 1 } } });
      for (let i = 0; i < 100 && replies.length < 4; i++) await new Promise((r) => setTimeout(r, 100));
      mcp.stdin.end();
      const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
      assert.equal(byId[1].result.serverInfo.name, 'eshop-lsp');
      const names = byId[2].result.tools.map((t) => t.name);
      assert.ok(names.includes('lsp_find_references') && names.includes('lsp_rename'));
      assert.ok(!names.includes('lsp_stop_server'));
      assert.match(byId[3].result.content[0].text, /fake hover/);
      assert.match(byId[4].result.content[0].text, /outside this checkout/);

      const calls = fs.readFileSync(path.join(worktree, '.git/lsp/calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(calls[0].agent, 'tester');
      assert.equal(calls[0].tool, 'lsp_hover');
      assert.equal(calls[0].file, path.join(worktree, 'src/A.cs'));
    } finally {
      delete process.env.LSP_RUNTIME_DIR;
    }

    const stopped = lspd('stop', '--worktree', worktree);
    assert.equal(stopped.stopped, true);
    assert.ok(!fs.existsSync(first.socket));
    assert.equal(fs.readdirSync(path.join(env.LSP_RUNTIME_DIR, 'leases')).length, 0);
    assert.equal(lspd('status', '--worktree', worktree).running, false);
  });

  test('recovers from a stale socket and pid file', () => {
    const paths = (() => {
      process.env.LSP_RUNTIME_DIR = env.LSP_RUNTIME_DIR;
      try {
        return daemonPaths(worktree);
      } finally {
        delete process.env.LSP_RUNTIME_DIR;
      }
    })();
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.socket, '');
    fs.writeFileSync(paths.pidFile, JSON.stringify({ pid: deadPid(), worktree, socket: paths.socket }));
    const st = lspd('start', '--worktree', worktree);
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.notEqual(st.pid, undefined);
    lspd('stop', '--worktree', worktree);
  });

  test('reports C# unavailable when no lease is free', () => {
    const leases = path.join(env.LSP_RUNTIME_DIR, 'leases');
    fs.mkdirSync(leases, { recursive: true });
    fs.writeFileSync(path.join(leases, 'slot-0.json'), JSON.stringify({ slot: 0, pid: process.pid, owner: '/other/worktree' }));
    try {
      const st = lspd('start', '--worktree', worktree);
      assert.equal(st.csharp, 'unavailable');
      assert.match(st.reason, /slots are in use/);
      const diag = lspd('diagnostics', '--worktree', worktree, '--files', path.join(worktree, 'src/A.cs'));
      assert.match(Object.values(diag.files)[0].unavailable, /C# language server unavailable .*use graphify and grep/);
    } finally {
      lspd('stop', '--worktree', worktree);
      fs.rmSync(path.join(leases, 'slot-0.json'), { force: true });
    }
  });
});
