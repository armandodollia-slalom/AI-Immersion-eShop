// lspd: one daemon per checkout. It runs lsp-mcp-server as a child (which starts the language servers lazily and
// stops idle ones), serves any number of MCP sessions and control requests over a unix socket, and holds the
// machine-wide lease for the checkout's C# server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  LSP_DIR,
  acquireLease,
  connect,
  daemonPaths,
  loadConfig,
  readJson,
  releaseLease,
  resolveNodeModule,
  serverForFile,
  stateDir,
  writeJsonAtomic,
} from './common.mjs';
import { solutionProjects } from './slnf.mjs';

// Tools the daemon manages itself: agents must not stop servers other sessions share.
const HIDDEN_TOOLS = new Set(['lsp_start_server', 'lsp_stop_server']);

const INSTRUCTIONS = [
  'Code intelligence for this checkout (eShop) through language servers: C# (Roslyn), TypeScript/JavaScript, bash, JSON, YAML, CSS, HTML.',
  'Use graphify first to find where to look; use these tools for precise facts at code graphify or a read already located:',
  'confirm definitions, signatures and callers (lsp_goto_definition, lsp_hover, lsp_find_references) before changing existing code,',
  'run lsp_diagnostics after every edit, and preview renames with lsp_rename dry_run=true.',
  'Paths must be absolute and inside this checkout; line and column are 1-indexed.',
  'When a C# call answers "C# language server unavailable", do not retry in a loop: use graphify and grep instead.',
].join(' ');

export function lspMcpConfig(config, worktree) {
  return {
    requestTimeout: (config.callTimeoutSec ?? 60) * 1000,
    idleTimeout: (config.idleSec ?? 900) * 1000,
    minify: 'full',
    logLevel: 'warn',
    servers: config.servers.map((s) => ({
      id: s.id,
      extensions: s.extensions,
      languageIds: s.languageIds,
      command: s.command ?? path.join(worktree, 'scripts/lsp/server.sh'),
      args: s.args ?? [s.id],
      rootPatterns: ['.git'],
    })),
  };
}

export async function serve({ worktree, slnf }) {
  const config = loadConfig();
  const paths = daemonPaths(worktree);
  const sdir = stateDir(worktree);
  const solution = slnf ? path.resolve(worktree, slnf) : path.join(worktree, config.defaultSolution);
  const startedAt = new Date().toISOString();
  const log = (...args) => process.stderr.write(`[lspd ${new Date().toISOString()}] ${args.join(' ')}\n`);
  fs.mkdirSync(paths.dir, { recursive: true });

  // Another daemon already serving this checkout: nothing to do.
  if (fs.existsSync(paths.socket)) {
    try {
      (await connect(paths.socket, 1000)).destroy();
      log(`another daemon already serves ${worktree}`);
      return 0;
    } catch {
      fs.rmSync(paths.socket, { force: true });
    }
  }

  const entry = resolveNodeModule(worktree, 'lsp-mcp-server/dist/index.js');
  if (!entry) throw new Error('lsp-mcp-server is not installed (run scripts/lsp/setup.sh or npm ci)');
  fs.writeFileSync(path.join(sdir, '.lsp-mcp.json'), `${JSON.stringify(lspMcpConfig(config, worktree), null, 2)}\n`);
  fs.rmSync(path.join(sdir, 'csharp.json'), { force: true });

  // ---- child: lsp-mcp-server over stdio ------------------------------------------------------------------
  const child = spawn(process.execPath, [entry], {
    cwd: sdir, // picks up the generated .lsp-mcp.json
    env: {
      ...process.env,
      LSP_WORKSPACE_ROOT: worktree,
      LSPD_STATE_DIR: sdir,
      ESHOP_LSP_SOLUTION: solution,
      LSP_LOG_LEVEL: process.env.LSP_LOG_LEVEL ?? 'warn',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let nextId = 1;
  const pending = new Map();
  let childBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    childBuffer += chunk;
    let nl;
    while ((nl = childBuffer.indexOf('\n')) >= 0) {
      const line = childBuffer.slice(0, nl).trim();
      childBuffer = childBuffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method && msg.id !== undefined) {
        // Server-to-client request (roots/list, ping, ...): answer with an empty result.
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [{ uri: `file://${worktree}`, name: path.basename(worktree) }] } : {} })}\n`);
      }
    }
  });
  const childRequest = (method, params, timeoutMs = 30000) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timedOut: true });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  let shuttingDown = false;
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      log(`lsp-mcp-server exited (${code ?? signal}); stopping`);
      shutdown(1);
    }
  });

  const init = await childRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: {} },
    clientInfo: { name: 'lspd', version: '1' },
  });
  if (!init.result) throw new Error(`lsp-mcp-server did not initialize: ${JSON.stringify(init.error ?? init)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = ((await childRequest('tools/list', {})).result?.tools ?? []).filter((t) => !HIDDEN_TOOLS.has(t.name));

  // ---- C# server: leased machine-wide ---------------------------------------------------------------------
  const csharpConfig = config.servers.find((s) => s.leased);
  let lease = null;
  let csharp = { status: 'unavailable', reason: 'not started' };
  let exitedSince = null;
  const csharpState = () => readJson(path.join(sdir, 'csharp.json'));

  // What to restore before Roslyn opens the solution: the filter itself, or for the full solution the configured
  // restoreSolution (eShop.Web.slnf: eShop.slnx also holds MAUI projects whose restore fails without workloads).
  const restoreTarget =
    !solution.endsWith('.slnf') && config.restoreSolution && fs.existsSync(path.join(worktree, config.restoreSolution))
      ? path.join(worktree, config.restoreSolution)
      : solution;

  // Projects of the restore target with no NuGet restore output yet (artifacts layout, UseArtifactsOutput=true).
  // Roslyn reports bogus "type not found" errors for them, so lspd restores first.
  function unrestoredProjects() {
    try {
      let projects;
      if (restoreTarget.endsWith('.slnf')) {
        const filter = JSON.parse(fs.readFileSync(restoreTarget, 'utf8')).solution;
        const slnDir = path.dirname(path.resolve(path.dirname(restoreTarget), filter.path));
        projects = filter.projects.map((p) => path.resolve(slnDir, p.replace(/\\/g, '/')));
      } else {
        projects = solutionProjects(restoreTarget).map((p) => path.resolve(path.dirname(restoreTarget), p));
      }
      return projects.filter((p) => {
        const name = path.basename(p, '.csproj');
        return !fs.existsSync(path.join(worktree, 'artifacts/obj', name, 'project.assets.json')) && !fs.existsSync(path.join(path.dirname(p), 'obj/project.assets.json'));
      });
    } catch {
      return [];
    }
  }

  function restoreThen(next) {
    const missing = unrestoredProjects();
    if (!missing.length) return next();
    csharp = { status: 'running', reason: null, startedAt: Date.now(), restoring: true };
    log(`restoring NuGet packages for ${missing.length} project(s) before starting C#`);
    const out = fs.openSync(path.join(sdir, 'restore.log'), 'w');
    const restore = spawn('dotnet', ['restore', restoreTarget], { cwd: worktree, stdio: ['ignore', out, out], env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
    fs.closeSync(out);
    restore.on('error', (error) => {
      log(`dotnet restore failed to start: ${error.message}`);
      next();
    });
    restore.on('exit', (code) => {
      log(`dotnet restore exited ${code}`);
      next();
    });
  }

  function startCsharp() {
    if (!csharpConfig) {
      csharp = { status: 'unavailable', reason: 'no C# server configured' };
      return;
    }
    if (lease?.ok) return;
    if (config.maxLanguageServers <= 0) {
      csharp = { status: 'unavailable', reason: 'C# language servers are disabled (maxLanguageServers=0)' };
      return;
    }
    lease = acquireLease({ owner: worktree, max: config.maxLanguageServers });
    if (!lease.ok) {
      csharp = { status: 'unavailable', reason: lease.reason };
      lease = null;
      return;
    }
    fs.rmSync(path.join(sdir, 'csharp.json'), { force: true });
    exitedSince = null;
    csharp = { status: 'running', reason: null, startedAt: Date.now() };
    log(`C# lease slot ${lease.slot}; opening ${path.relative(worktree, solution) || solution}`);
    restoreThen(() => {
      csharp.restoring = false;
      if (!lease?.ok || shuttingDown) return;
      launchCsharp();
    });
  }

  function launchCsharp() {
    // Spawns Roslyn through scripts/lsp/server.sh; the initialize handshake returns long before the solution loads.
    childRequest('tools/call', { name: 'lsp_start_server', arguments: { server_id: csharpConfig.id, workspace_root: worktree } }, 300000).then((res) => {
      if (res.result?.isError || res.error || res.timedOut) {
        const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? 'timed out');
        log(`C# server failed to start: ${text}`);
        csharp = { status: 'unavailable', reason: `failed to start: ${text.slice(0, 300)}` };
        releaseLease(lease);
        lease = null;
      }
    });
  }

  // Why a C# request cannot be served right now, or null when it can.
  function csharpBlocker() {
    if (!lease?.ok) startCsharp();
    if (csharp.status !== 'running') return csharp.reason;
    const state = csharpState();
    const elapsed = Math.round((Date.now() - csharp.startedAt) / 1000);
    const loadLimit = config.csharpLoadTimeoutSec ?? 900;
    if (csharp.restoring) return `restoring NuGet packages for ${path.basename(solution)} (${elapsed}s so far)`;
    if (!state || state.state === 'starting' || state.state === 'loading') {
      if (elapsed > loadLimit) return null; // never got the "loaded" notification; try anyway
      return `still loading ${path.basename(solution)} (${elapsed}s so far)`;
    }
    if (state.state === 'exited') return 'the server exited; it restarts on the next C# request';
    return null;
  }

  // Idle C# server stopped by lsp-mcp-server, or crashed for good: give the slot back.
  const leaseWatch = setInterval(() => {
    if (!lease?.ok) return;
    const state = csharpState();
    if (state?.state === 'exited') {
      exitedSince ??= Date.now();
      if (Date.now() - exitedSince > 15000) {
        log('C# server stopped; releasing lease');
        releaseLease(lease);
        lease = null;
        csharp = { status: 'unavailable', reason: 'stopped after being idle; it restarts on the next C# request' };
      }
    } else exitedSince = null;
  }, 5000);
  leaseWatch.unref();

  const unavailable = (reason) => `C# language server unavailable (${reason}); use graphify and grep`;

  // Resolves symlinks (/tmp vs /private/tmp) so paths compare against the real checkout path.
  const realPath = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      try {
        return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
      } catch {
        return p;
      }
    }
  };

  // Checks a tool call's target; returns an error text or null.
  function gate(args = {}) {
    const file = args.file_path;
    if (file) {
      const abs = realPath(path.resolve(worktree, file));
      if (abs !== worktree && !abs.startsWith(`${worktree}${path.sep}`)) {
        return `${file} is outside this checkout (${worktree}); this server only answers for its own checkout`;
      }
      if (serverForFile(config, abs)?.leased) {
        const blocker = csharpBlocker();
        if (blocker) return unavailable(blocker);
      }
    }
    if (args.server_id && args.server_id === csharpConfig?.id) {
      const blocker = csharpBlocker();
      if (blocker) return unavailable(blocker);
    }
    return null;
  }

  let lastActivity = Date.now();
  const callTimeoutMs = (config.callTimeoutSec ?? 60) * 1000;

  async function callTool(name, args) {
    lastActivity = Date.now();
    if (HIDDEN_TOOLS.has(name)) return { content: [{ type: 'text', text: `${name} is managed by lspd` }], isError: true };
    const blocked = gate(args);
    if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true };
    if (typeof args.file_path === 'string') args = { ...args, file_path: realPath(path.resolve(worktree, args.file_path)) };
    const res = await childRequest('tools/call', { name, arguments: args }, callTimeoutMs);
    lastActivity = Date.now();
    if (res.timedOut) {
      const isCs = args?.file_path && serverForFile(config, args.file_path)?.leased;
      const why = `no answer within ${callTimeoutMs / 1000}s`;
      return { content: [{ type: 'text', text: isCs ? unavailable(why) : `Language server busy (${why}); use graphify and grep` }], isError: true };
    }
    if (res.error) return { content: [{ type: 'text', text: res.error.message ?? JSON.stringify(res.error) }], isError: true };
    return res.result;
  }

  async function diagnostics(files) {
    const out = {};
    const timeoutMs = (config.diagnosticsTimeoutSec ?? 20) * 1000;
    for (const file of files) {
      const abs = realPath(path.resolve(worktree, file));
      const server = serverForFile(config, abs);
      if (!server) {
        out[file] = { unavailable: 'no language server for this file type' };
        continue;
      }
      if (!fs.existsSync(abs)) {
        out[file] = { unavailable: 'file not found' };
        continue;
      }
      const blocked = gate({ file_path: abs });
      if (blocked) {
        out[file] = { unavailable: blocked };
        continue;
      }
      const res = await childRequest('tools/call', { name: 'lsp_diagnostics', arguments: { file_path: abs, severity_filter: 'all' } }, timeoutMs);
      lastActivity = Date.now();
      const text = res.result?.content?.[0]?.text;
      if (res.timedOut || !text || res.result?.isError) {
        out[file] = { unavailable: res.timedOut ? `no answer within ${timeoutMs / 1000}s` : (text ?? 'no answer').slice(0, 300) };
        continue;
      }
      try {
        out[file] = (JSON.parse(text).diagnostics ?? []).map((d) => ({
          severity: d.severity,
          line: d.range?.start?.line,
          col: d.range?.start?.column,
          code: d.code ?? null,
          message: d.message,
        }));
      } catch {
        out[file] = { unavailable: text.slice(0, 300) };
      }
    }
    return out;
  }

  // ---- socket server ----------------------------------------------------------------------------------------
  const sessions = new Set();

  function status() {
    const state = csharpState();
    return {
      ok: true,
      running: true,
      pid: process.pid,
      socket: paths.socket,
      worktree,
      stateDir: sdir,
      solution,
      startedAt,
      sessions: sessions.size,
      lastActivity: new Date(lastActivity).toISOString(),
      csharp: csharp.status,
      csharpState: csharp.status === 'running' ? (csharp.restoring ? 'restoring' : (state?.state ?? 'starting')) : null,
      reason: csharp.status === 'running' ? null : csharp.reason,
      leaseSlot: lease?.ok ? lease.slot : null,
    };
  }

  function mcpSession(conn, header, rest) {
    sessions.add(conn);
    const send = (msg) => conn.writable && conn.write(`${JSON.stringify(msg)}\n`);
    const handle = async (msg) => {
      lastActivity = Date.now();
      if (msg.id === undefined) return; // notifications (initialized, cancelled) need no answer
      const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
      switch (msg.method) {
        case 'initialize':
          return reply({
            protocolVersion: msg.params?.protocolVersion ?? init.result.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'eshop-lsp', version: init.result.serverInfo?.version ?? '0' },
            instructions: INSTRUCTIONS,
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools });
        case 'tools/call':
          return reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
        default:
          return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
    };
    let buffer = rest;
    const drain = () => {
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        handle(msg).catch((error) => log(`session error: ${error.stack ?? error}`));
      }
    };
    conn.on('data', (chunk) => {
      buffer += chunk;
      drain();
    });
    conn.on('close', () => {
      sessions.delete(conn);
      lastActivity = Date.now();
    });
    drain();
  }

  const server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    let head = '';
    const onData = async (chunk) => {
      head += chunk;
      const nl = head.indexOf('\n');
      if (nl < 0) return;
      conn.off('data', onData);
      let header;
      try {
        header = JSON.parse(head.slice(0, nl));
      } catch {
        conn.end(`${JSON.stringify({ ok: false, error: 'expected a JSON header line' })}\n`);
        return;
      }
      const rest = head.slice(nl + 1);
      const answer = (obj) => conn.end(`${JSON.stringify(obj)}\n`);
      switch (header.lspd) {
        case 'mcp':
          return mcpSession(conn, header, rest);
        case 'status':
          return answer(status());
        case 'diagnostics':
          return answer({ ok: true, files: await diagnostics(header.files ?? []) });
        case 'stop':
          answer({ ok: true, stopped: true, pid: process.pid });
          return shutdown(0);
        default:
          return answer({ ok: false, error: `unknown request ${header.lspd}` });
      }
    };
    conn.on('data', onData);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(paths.socket, 0o600);
  writeJsonAtomic(paths.pidFile, { pid: process.pid, worktree, socket: paths.socket, stateDir: sdir, solution, startedAt });
  log(`serving ${worktree} on ${paths.socket} (pid ${process.pid})`);

  startCsharp();

  const idleMs = (config.idleSec ?? 900) * 1000;
  const idleWatch = setInterval(() => {
    if (sessions.size === 0 && Date.now() - lastActivity > idleMs) {
      log(`idle for ${config.idleSec}s with no sessions; stopping`);
      shutdown(0);
    }
  }, Math.min(30000, idleMs));
  idleWatch.unref();

  function cleanupFiles() {
    if (readJson(paths.pidFile)?.pid === process.pid) {
      fs.rmSync(paths.pidFile, { force: true });
      fs.rmSync(paths.socket, { force: true });
    }
    releaseLease(lease);
    lease = null;
  }

  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleWatch);
    clearInterval(leaseWatch);
    server.close();
    for (const conn of sessions) conn.destroy();
    cleanupFiles();
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    killTimer.unref();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    process.exit(code);
  }
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', cleanupFiles);
  return new Promise(() => {}); // runs until shutdown()
}
