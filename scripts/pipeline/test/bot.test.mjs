// The pipeline's PR bot (lib/bot.mjs, lib/bot-setup.mjs): names, the App JWT, installation tokens and
// their cache, the fallback to the developer's login, redaction, the manifest, and the PR paths of
// implement (single ticket) and epic (group PRs) running `gh pr create` as the bot.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { MAX_APP_NAME, appJwt, botName, botSettings, botPush, installationToken, loadCredentials, prPublisher, pushWithToken, redact, resetBot, resolveBot, saveCredentials } from '../lib/bot.mjs';
import { PERMISSIONS, appManifest, manifestPage, newAppUrl, runManifestServer } from '../lib/bot-setup.mjs';
import { openStoryPr } from '../../implement/lib/implement.mjs';
import { openPr } from '../../implement/lib/epic.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const creds = { source: 'file', name: 'dev-bot-octocat', appId: '4242', slug: 'dev-bot-octocat', owner: 'octocat', privateKey };
const TOKEN = 'ghs_s3cretInstallationToken0123456789';
const config = { root: '/nowhere', bot: { enabled: true, namePattern: 'dev-bot-{login}', credentialsDir: '/nowhere/creds' } };

afterEach(() => resetBot());

// A fake api.github.com: the installation of the repo, and a token per POST.
function fakeFetch({ installed = true, tokens = [TOKEN], expiresInMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, json) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) });
    if (url.endsWith('/repos/acme/shop/installation')) return installed ? reply(200, { id: 77, account: { login: 'acme' } }) : reply(404, { message: 'Not Found' });
    if (url.endsWith('/app/installations/77/access_tokens')) return reply(201, { token: tokens[Math.min(n++, tokens.length - 1)], expires_at: new Date(now() + expiresInMs).toISOString() });
    return reply(404, { message: 'Not Found' });
  };
  return { fetch, calls };
}

test('botName: dev-bot-{login} from the pattern, lowercased, truncated with a hash to 34 characters', () => {
  assert.equal(botName('ArmandoDollia-Slalom'), 'dev-bot-armandodollia-slalom');
  assert.equal(botName('octocat', 'pipeline-{login}-bot'), 'pipeline-octocat-bot');
  const long = botName('a-very-long-github-login-name-indeed');
  assert.ok(long.length <= MAX_APP_NAME);
  assert.match(long, /^dev-bot-a-very-long-github-[0-9a-f]{6}$/, 'a cut ending in a hyphen drops it');
  assert.equal(botName('abcdefghijklmnopqrstuvwxyz0123').length, MAX_APP_NAME);
  assert.notEqual(long, botName('a-very-long-github-login-name-other'), 'two long logins with the same prefix get different names');
  assert.equal(botName('a-very-long-github-login-name-indeed'), long, 'stable');
});

test('botSettings: defaults, ~ expanded, PIPELINE_BOT=0 turns it off', () => {
  const s = botSettings({ root: '/x' }, {});
  assert.equal(s.enabled, true);
  assert.equal(s.namePattern, 'dev-bot-{login}');
  assert.equal(s.credentialsDir, path.join(os.homedir(), '.config/eshop-pipeline'));
  assert.equal(botSettings({ root: '/x' }, { PIPELINE_BOT: '0' }).enabled, false);
  assert.equal(botSettings({ root: '/x', bot: { enabled: false } }, {}).enabled, false);
});

test('appJwt: RS256, verifiable with the public key, iat 60 s back, exp 9 minutes ahead, iss = App id', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const jwt = appJwt('4242', privateKey, now);
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 4242);
  assert.equal(claims.iat, now / 1000 - 60);
  assert.equal(claims.exp, now / 1000 + 9 * 60);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')));
});

test('installationToken: JWT → installation → token for the repo, cached until 5 minutes before it expires', async () => {
  let clock = Date.UTC(2026, 0, 1);
  const now = () => clock;
  const gh = fakeFetch({ tokens: ['ghs_first', 'ghs_second'], now });
  const opts = { fetch: gh.fetch, now, creds, repo: 'acme/shop' };
  assert.equal(await installationToken(config, opts), 'ghs_first');
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET', 'POST']);
  assert.match(gh.calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(gh.calls[1].body, { repositories: ['shop'] }, 'the token is limited to the repo');
  clock += 50 * 60 * 1000;
  assert.equal(await installationToken(config, opts), 'ghs_first', 'still 10 minutes left: cached');
  assert.equal(gh.calls.length, 2);
  clock += 6 * 60 * 1000;
  assert.equal(await installationToken(config, opts), 'ghs_second', '4 minutes left: a new token');
  assert.equal(gh.calls.length, 4);
});

test('installationToken: not installed on the repo is an error that names the App, without secrets', async () => {
  const gh = fakeFetch({ installed: false });
  await assert.rejects(installationToken(config, { fetch: gh.fetch, creds, repo: 'acme/shop' }), (e) => /dev-bot-octocat is not installed on acme\/shop: HTTP 404/.test(e.message) && !e.message.includes('BEGIN'));
});

test('not configured: a loud warning naming `pipeline bot setup` (once), and the developer\'s gh login', async () => {
  const logs = [];
  const gitCalls = [];
  const deps = { creds: null, repo: 'acme/shop', env: {}, log: (m) => logs.push(m), git: (cwd, args) => (gitCalls.push(args), { status: 0, stdout: '', stderr: '' }) };
  assert.equal(await resolveBot(config, deps), null);
  const pub = await prPublisher(config, deps);
  assert.equal(pub.bot, null);
  assert.equal(pub.env, undefined, 'gh runs as the developer');
  pub.push('/wt', 'feature/x');
  assert.deepEqual(gitCalls[0], ['push', '-u', 'origin', 'feature/x']);
  assert.ok(logs.some((l) => l.startsWith('WARNING:') && l.includes('node scripts/pipeline/pipeline.mjs bot setup')));
  assert.equal(logs.length, 2, 'warned once per process');
});

test('disabled (PIPELINE_BOT=0) or not a GitHub repo: no bot and no warning', async () => {
  const logs = [];
  assert.equal(await resolveBot(config, { env: { PIPELINE_BOT: '0' }, creds, repo: 'acme/shop', log: (m) => logs.push(m) }), null);
  assert.equal(await resolveBot(config, { env: {}, creds, repo: null, log: (m) => logs.push(m) }), null);
  assert.deepEqual(logs, []);
});

test('credentials: saved outside the repo at 0600, loaded for dev-bot-<login>; environment variables win', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-creds-'));
  try {
    const cfg = { root: '/nowhere', bot: { credentialsDir: dir } };
    const settings = botSettings(cfg, {});
    const file = saveCredentials(settings, 'dev-bot-octocat', { appId: 4242, slug: 'dev-bot-octocat', owner: 'octocat', pem: privateKey });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['appId', 'owner', 'privateKeyFile', 'slug']);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, saved.privateKeyFile)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    const loaded = loadCredentials(cfg, { env: {}, login: 'OctoCat' });
    assert.equal(loaded.appId, '4242');
    assert.equal(loaded.privateKey, privateKey);
    assert.equal(loadCredentials(cfg, { env: {}, login: 'someone-else' }), null);
    const fromEnv = loadCredentials(cfg, { env: { PIPELINE_BOT_APP_ID: '99', PIPELINE_BOT_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') }, login: 'octocat' });
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.appId, '99');
    assert.equal(fromEnv.privateKey, privateKey);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('push as the bot: the token is in a header from the environment, never in args or output; upstream is origin/<branch>', () => {
  const calls = [];
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  const fakeGit = (cwd, args, opts = {}) => {
    calls.push({ args, env: opts.env });
    if (args.includes('push')) return { status: 1, stdout: '', stderr: `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/acme/shop.git/': ${TOKEN} ${basic} rejected` };
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = pushWithToken('/wt', 'fix/bug-7', { repo: 'acme/shop', token: TOKEN, git: fakeGit });
  assert.equal(r.status, 1);
  assert.ok(!r.stderr.includes(TOKEN) && !r.stderr.includes(basic), r.stderr);
  const push = calls[0];
  assert.deepEqual(push.args, ['-c', 'credential.helper=', 'push', 'https://github.com/acme/shop.git', 'refs/heads/fix/bug-7:refs/heads/fix/bug-7']);
  assert.ok(!push.args.join(' ').includes(TOKEN));
  assert.equal(push.env.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${basic}`);
  assert.equal(calls.length, 1, 'no upstream for a failed push');

  calls.length = 0;
  const ok = (cwd, args, opts = {}) => (calls.push({ args, env: opts.env }), { status: 0, stdout: '', stderr: '' });
  pushWithToken('/wt', 'fix/bug-7', { repo: 'acme/shop', token: TOKEN, git: ok });
  assert.deepEqual(calls.slice(1).map((c) => c.args), [
    ['update-ref', 'refs/remotes/origin/fix/bug-7', 'refs/heads/fix/bug-7'],
    ['branch', '--set-upstream-to=origin/fix/bug-7', 'fix/bug-7'],
  ]);
});

test('botPush: a failed push throws without the token', async () => {
  const gh = fakeFetch();
  const fakeGit = () => ({ status: 128, stdout: '', stderr: `remote: Permission denied to ${TOKEN}` });
  await assert.rejects(botPush('/wt', 'fix/bug-7', config, { fetch: gh.fetch, creds, repo: 'acme/shop', git: fakeGit }), (e) => /as the bot failed/.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(redact(`https://user:${TOKEN}@github.com/x`, TOKEN), 'https://user:***@github.com/x');
});

test('the App manifest: dev-bot name, the repo URL, private, no webhook, the local callback, the four permissions, no events', () => {
  const m = appManifest({ name: 'dev-bot-octocat', repo: 'acme/shop', port: 51234 });
  assert.equal(m.name, 'dev-bot-octocat');
  assert.equal(m.url, 'https://github.com/acme/shop');
  assert.equal(m.public, false);
  assert.equal(m.hook_attributes.active, false);
  assert.equal(m.redirect_url, 'http://127.0.0.1:51234/callback');
  assert.deepEqual(m.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' });
  assert.deepEqual(PERMISSIONS, m.default_permissions);
  assert.deepEqual(m.default_events, []);
  assert.equal(newAppUrl({ state: 'abc' }), 'https://github.com/settings/apps/new?state=abc');
  assert.equal(newAppUrl({ org: 'acme', state: 'abc' }), 'https://github.com/organizations/acme/settings/apps/new?state=abc');
  const html = manifestPage({ manifest: m, action: newAppUrl({ state: 'abc' }) });
  assert.match(html, /<form id="f" method="post" action="https:\/\/github.com\/settings\/apps\/new\?state=abc">/);
  assert.ok(html.includes('&quot;redirect_url&quot;:&quot;http://127.0.0.1:51234/callback&quot;'));
});

test('setup: the local server posts the manifest, refuses a wrong state, and saves the App from the code (PEM 0600)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-setup-'));
  try {
    const settings = botSettings({ root: '/x', bot: { credentialsDir: dir } }, {});
    const conversions = [];
    const githubFetch = async (url, init) => {
      conversions.push({ url, method: init.method });
      return { ok: true, status: 201, json: async () => ({ id: 4242, slug: 'dev-bot-octocat', owner: { login: 'octocat' }, pem: privateKey, client_secret: 'not-saved' }) };
    };
    const statuses = [];
    let browsing;
    const open = (local) => (browsing = browse(local));
    const browse = async (local) => {
      const html = await (await fetch(local)).text();
      const state = /state=([0-9a-f]+)/.exec(html)[1];
      assert.match(html, /&quot;redirect_url&quot;:&quot;http:\/\/127\.0\.0\.1:\d+\/callback&quot;/);
      statuses.push((await fetch(`${local}callback?state=wrong&code=c0de`)).status);
      statuses.push((await fetch(`${local}callback?state=${state}&code=c0de`)).status);
    };
    const saved = await runManifestServer({ name: 'dev-bot-octocat', repo: 'acme/shop', settings, fetch: githubFetch, open, log: () => {}, timeoutMs: 10000 });
    await browsing;
    assert.deepEqual(statuses, [400, 200]);
    assert.deepEqual(conversions, [{ url: 'https://api.github.com/app-manifests/c0de/conversions', method: 'POST' }]);
    assert.deepEqual({ appId: saved.appId, slug: saved.slug, owner: saved.owner }, { appId: 4242, slug: 'dev-bot-octocat', owner: 'octocat' });
    const stored = fs.readFileSync(saved.file, 'utf8');
    assert.ok(!stored.includes('not-saved') && !stored.includes('BEGIN'), 'only the id, slug, owner and key file name are stored in the JSON');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, JSON.parse(stored).privateKeyFile)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A publisher as prPublisher builds it for a set-up bot, with git and gh stubbed.
async function botPublisher() {
  const gh = fakeFetch();
  const pushes = [];
  const fakeGit = (cwd, args, opts = {}) => (pushes.push({ cwd, args, env: opts.env }), { status: 0, stdout: '', stderr: '' });
  const publisher = await prPublisher(config, { fetch: gh.fetch, creds, repo: 'acme/shop', env: {}, git: fakeGit, log: () => {} });
  const ghCalls = [];
  const run = (cmd, args, opts = {}) => (ghCalls.push({ cmd, args, env: opts.env, cwd: opts.cwd }), { status: 0, stdout: 'https://github.com/acme/shop/pull/12\n', stderr: '' });
  return { publisher, pushes, ghCalls, run };
}

test('implement single-ticket PR: pushed and opened with gh pr create as the bot', async () => {
  const b = await botPublisher();
  assert.equal(b.publisher.bot, 'dev-bot-octocat');
  const r = await openStoryPr({ root: '/repo' }, { worktree: '/wt', branch: 'fix/BUG-7', base: 'main', title: 'BUG-7: fix', body: 'body' }, { publisher: b.publisher, run: b.run });
  assert.equal(r.url, 'https://github.com/acme/shop/pull/12');
  assert.equal(b.pushes[0].args[2], 'push');
  assert.equal(b.ghCalls.length, 1);
  assert.deepEqual(b.ghCalls[0].args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', 'fix/BUG-7']);
  assert.equal(b.ghCalls[0].env.GH_TOKEN, TOKEN, 'gh pr create runs with the bot token');
});

test('implement single-ticket PR: an already open PR is looked up as the bot', async () => {
  const b = await botPublisher();
  const failing = (cmd, args, opts) => (b.ghCalls.push({ args, env: opts.env }), { status: 1, stdout: '', stderr: 'a pull request already exists' });
  let lookupEnv;
  const r = await openStoryPr({ root: '/repo' }, { worktree: '/wt', branch: 'fix/BUG-7', base: 'main', title: 't', body: 'b' }, { publisher: b.publisher, run: failing, openPrFor: (cfg, branch, env) => ((lookupEnv = env), 'https://github.com/acme/shop/pull/9') });
  assert.equal(r.url, 'https://github.com/acme/shop/pull/9');
  assert.equal(lookupEnv.GH_TOKEN, TOKEN);
});

test('epic group PR: openPr pushes and runs gh pr create as the bot against the unit base', async () => {
  const b = await botPublisher();
  const r = await openPr({ worktree: '/wt/group', branch: 'epic/bugs-g1', prBase: 'origin/main' }, { title: 'Fix BUG-1, BUG-2: login', body: 'b' }, { publisher: b.publisher, run: b.run });
  assert.deepEqual(r, { url: 'https://github.com/acme/shop/pull/12' });
  assert.equal(b.pushes[0].cwd, '/wt/group');
  assert.deepEqual(b.ghCalls[0].args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', 'epic/bugs-g1']);
  assert.equal(b.ghCalls[0].env.GH_TOKEN, TOKEN);
});
