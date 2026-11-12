// The pipeline's PR identity: a GitHub App per developer, named `dev-bot-<gh login>` (`bot.namePattern`
// in scripts/pipeline/config.json). The pipeline pushes the branches of its PRs and opens the PRs with
// the App's installation token, so the developer is not the PR's author and can approve it with
// GitHub's normal review flow. Everything else (board, labels, reviews) stays the developer's gh login.
// Commit authorship is unchanged. See docs/ai-pipeline/setup.md#the-pipelines-pr-bot.
//
// Credentials live outside the repo: <bot.credentialsDir>/<bot name>.json ({ appId, slug, owner,
// privateKeyFile }) and the private key next to it (mode 0600), written by `pipeline bot setup`. CI
// sets PIPELINE_BOT_APP_ID and PIPELINE_BOT_PRIVATE_KEY (or PIPELINE_BOT_PRIVATE_KEY_FILE) instead.
// When the bot is enabled but not set up, the pipeline warns and uses the developer's login.
//
// No token ever reaches a log, an error or a thrown message: git output is redacted, and the push
// sends the token in a header from the environment, never on the command line or in a URL.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git } from './git.mjs';
import { log as defaultLog, readJson, run, tail } from './util.mjs';

export const API = 'https://api.github.com';
// GitHub App names are global and at most 34 characters.
export const MAX_APP_NAME = 34;
export const BOT_DEFAULTS = { enabled: true, namePattern: 'dev-bot-{login}', credentialsDir: '~/.config/eshop-pipeline' };
const SETUP_CMD = 'node scripts/pipeline/pipeline.mjs bot setup';
const REFRESH_MS = 5 * 60 * 1000;

// `dev-bot-{login}` with the gh login. A name over 34 characters keeps its first 27 and ends with
// `-` and 6 hex characters of a hash of the full name, so two long logins with the same prefix differ.
export function botName(login, pattern = BOT_DEFAULTS.namePattern) {
  const full = String(pattern || BOT_DEFAULTS.namePattern).replaceAll('{login}', String(login ?? '').toLowerCase());
  if (full.length <= MAX_APP_NAME) return full;
  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 6);
  return `${full.slice(0, MAX_APP_NAME - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}

const expandHome = (p) => (p === '~' ? os.homedir() : /^~[/\\]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);

// config.bot with its defaults; PIPELINE_BOT=0 turns the bot off.
export function botSettings(config, env = process.env) {
  const s = { ...BOT_DEFAULTS, ...(config?.bot ?? {}) };
  return {
    ...s,
    enabled: s.enabled !== false && env.PIPELINE_BOT !== '0',
    credentialsDir: path.resolve(expandHome(env.PIPELINE_BOT_CREDENTIALS_DIR || s.credentialsDir)),
  };
}

// owner/name of the origin remote when it is on GitHub, else null (a local or test repo: no PRs).
export function repoOf(config, { git: g = git } = {}) {
  const url = g(config.root, ['remote', 'get-url', 'origin']).stdout?.trim() ?? '';
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}

let loginCache;
// The login of the developer's gh CLI (PIPELINE_BOT_LOGIN overrides it).
export function ghLogin({ run: r = run, env = process.env } = {}) {
  if (env.PIPELINE_BOT_LOGIN) return env.PIPELINE_BOT_LOGIN;
  if (loginCache !== undefined) return loginCache;
  const res = r('gh', ['api', 'user', '--jq', '.login'], { timeoutSec: 60 });
  loginCache = res.status === 0 ? res.stdout.trim() || null : null;
  return loginCache;
}

export const credentialsFile = (settings, name) => path.join(settings.credentialsDir, `${name}.json`);

// The App's id and private key: from the environment (CI), else from the credentials file of
// `dev-bot-<login>`. Null when there are none. The result holds the private key: never log it.
export function loadCredentials(config, { env = process.env, login, run: r } = {}) {
  if (env.PIPELINE_BOT_APP_ID && (env.PIPELINE_BOT_PRIVATE_KEY || env.PIPELINE_BOT_PRIVATE_KEY_FILE)) {
    const keyFile = env.PIPELINE_BOT_PRIVATE_KEY_FILE;
    const privateKey = env.PIPELINE_BOT_PRIVATE_KEY ? env.PIPELINE_BOT_PRIVATE_KEY.replace(/\\n/g, '\n') : fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : null;
    if (!privateKey) return null;
    return { source: 'env', name: env.PIPELINE_BOT_NAME ?? null, appId: String(env.PIPELINE_BOT_APP_ID), slug: env.PIPELINE_BOT_SLUG ?? null, owner: null, privateKey };
  }
  const settings = botSettings(config, env);
  const who = login ?? ghLogin({ env, ...(r ? { run: r } : {}) });
  if (!who) return null;
  const name = botName(who, settings.namePattern);
  const file = credentialsFile(settings, name);
  const data = readJson(file, null);
  if (!data?.appId || !data.privateKeyFile) return null;
  const keyFile = path.resolve(path.dirname(file), data.privateKeyFile);
  if (!fs.existsSync(keyFile)) return null;
  return { source: 'file', file, name, appId: String(data.appId), slug: data.slug ?? null, owner: data.owner ?? null, privateKey: fs.readFileSync(keyFile, 'utf8') };
}

// Writes the credentials file and the private key (both 0600, in a 0700 folder). Returns the file.
export function saveCredentials(settings, name, { appId, slug, owner, pem }) {
  fs.mkdirSync(settings.credentialsDir, { recursive: true, mode: 0o700 });
  const keyName = `${name}.private-key.pem`;
  const keyPath = path.join(settings.credentialsDir, keyName);
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  const file = credentialsFile(settings, name);
  fs.writeFileSync(file, `${JSON.stringify({ appId, slug, owner, privateKeyFile: keyName }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

const b64url = (data) => Buffer.from(data).toString('base64url');

// The App's JWT (RS256): issued 60 s in the past against clock drift, valid for 9 minutes.
export function appJwt(appId, privateKey, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 60 + 9 * 60, iss: /^\d+$/.test(String(appId)) ? Number(appId) : String(appId) }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

// Removes every secret from text: the given values, their basic-auth form, and any token in a URL.
export function redact(text, ...secrets) {
  let out = String(text ?? '');
  for (const s of secrets.filter((x) => x && String(x).length >= 4)) {
    out = out.split(String(s)).join('***');
    out = out.split(Buffer.from(`x-access-token:${s}`).toString('base64')).join('***');
  }
  return out.replace(/(https?:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1***@');
}

export async function githubApi(fetchFn, method, route, token, body) {
  const res = await fetchFn(`${API}${route}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'eshop-pipeline-bot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

const apiError = (what, r) => `${what}: HTTP ${r.status}${r.json?.message ? ` (${String(r.json.message).slice(0, 200)})` : ''}`;

// The App's installation on the repo, or { ok: false, status } when it is not installed there.
export async function installation(creds, repo, { fetch: f = globalThis.fetch, now = () => Date.now() } = {}) {
  const r = await githubApi(f, 'GET', `/repos/${repo}/installation`, appJwt(creds.appId, creds.privateKey, now()));
  return r.ok ? { ok: true, id: r.json?.id, account: r.json?.account?.login ?? null } : { ok: false, status: r.status, message: r.json?.message ?? null };
}

const tokenCache = new Map();
const warned = new Set();

// Clears the in-memory token cache, the gh login and the one-time warnings (tests).
export function resetBot() {
  tokenCache.clear();
  warned.clear();
  loginCache = undefined;
}

// An installation token for the repo, limited to it, cached in memory until 5 minutes before it
// expires. Throws (without any secret in the message) when the App is not installed or GitHub refuses.
export async function installationToken(config, { fetch: f = globalThis.fetch, now = () => Date.now(), creds, repo, env = process.env } = {}) {
  creds ??= loadCredentials(config, { env });
  if (!creds) throw new Error(`the pipeline's PR bot is not configured (run \`${SETUP_CMD}\`)`);
  repo ??= repoOf(config);
  if (!repo) throw new Error('the origin remote is not a GitHub repository');
  const key = `${creds.appId}:${repo}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - now() > REFRESH_MS) return hit.token;
  const jwt = appJwt(creds.appId, creds.privateKey, now());
  const inst = await githubApi(f, 'GET', `/repos/${repo}/installation`, jwt);
  if (!inst.ok || !inst.json?.id) throw new Error(apiError(`the GitHub App ${creds.slug ?? creds.appId} is not installed on ${repo}`, inst));
  const tok = await githubApi(f, 'POST', `/app/installations/${inst.json.id}/access_tokens`, jwt, { repositories: [repo.split('/')[1]] });
  if (!tok.ok || !tok.json?.token) throw new Error(apiError(`GitHub refused an installation token for ${creds.slug ?? creds.appId}`, tok));
  const expiresAt = Date.parse(tok.json.expires_at ?? '') || now() + 60 * 60 * 1000;
  tokenCache.set(key, { token: tok.json.token, expiresAt });
  return tok.json.token;
}

function warnOnce(key, lines, logFn) {
  if (warned.has(key)) return;
  warned.add(key);
  for (const line of lines) logFn(`WARNING: ${line}`);
}

// { name, repo, token } of the bot for this repo, or null: the bot is off, the origin is not on
// GitHub, or the bot is not set up or cannot mint a token (then a loud warning, once per process,
// and the caller uses the developer's gh login as before).
export async function resolveBot(config, deps = {}) {
  const env = deps.env ?? process.env;
  const logFn = deps.log ?? defaultLog;
  if (!botSettings(config, env).enabled) return null;
  const repo = deps.repo !== undefined ? deps.repo : repoOf(config);
  if (!repo) return null;
  const creds = deps.creds !== undefined ? deps.creds : loadCredentials(config, { env, run: deps.run });
  if (!creds) {
    warnOnce('not-configured', [
      "the pipeline's PR bot (dev-bot-<your gh login>) is not set up, so its PRs are opened with your own gh login and GitHub will not let you approve them.",
      `run \`${SETUP_CMD}\` once (PIPELINE_BOT=0 turns the bot off and silences this).`,
    ], logFn);
    return null;
  }
  const name = creds.name ?? creds.slug ?? `app ${creds.appId}`;
  try {
    return { name, repo, token: await installationToken(config, { fetch: deps.fetch, now: deps.now, creds, repo, env }) };
  } catch (error) {
    warnOnce('token', [
      `the pipeline's PR bot ${name} could not get a token (${redact(error.message)}); this PR is opened with your own gh login.`,
      'run `node scripts/pipeline/pipeline.mjs bot status` to see what is missing.',
    ], logFn);
    return null;
  }
}

// { GH_TOKEN } for gh calls as the bot, or null (bot off or not configured: use the developer's gh).
export async function botEnv(config, deps = {}) {
  const bot = await resolveBot(config, deps);
  return bot ? { GH_TOKEN: bot.token } : null;
}

// botEnv for synchronous callers (the review gate's merge): runs it in a child process.
export function botEnvSync(config) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'env', config.root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120000, windowsHide: true });
  try {
    return r.status === 0 ? JSON.parse(r.stdout || 'null') : null;
  } catch {
    return null;
  }
}

// Pushes a branch with an installation token. The token goes to git in an Authorization header set
// from the environment (it never appears on the command line, in a URL or in the output), the
// developer's credential helpers are bypassed, and the branch's upstream is set to origin/<branch>.
export function pushWithToken(cwd, branch, { repo, token, upstream = true, git: g = git }) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // The empty value first clears any other extra header for github.com (actions/checkout sets one).
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: header,
  };
  const r = g(cwd, ['-c', 'credential.helper=', 'push', `https://github.com/${repo}.git`, `refs/heads/${branch}:refs/heads/${branch}`], { env });
  const out = { status: r.status, stdout: redact(r.stdout, token), stderr: redact(r.stderr, token) };
  if (out.status === 0 && upstream) {
    g(cwd, ['update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
    g(cwd, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
  }
  return out;
}

// Pushes a branch as the bot. Throws when the bot is not configured or the push fails; neither
// message can hold the token (installationToken never puts it in one, and git's output is redacted).
export async function botPush(cwd, branch, config, deps = {}) {
  const repo = deps.repo ?? repoOf(config);
  const token = await installationToken(config, { ...deps, repo });
  const r = pushWithToken(cwd, branch, { repo, token, upstream: deps.upstream ?? true, git: deps.git });
  if (r.status !== 0) throw new Error(`git push of ${branch} as the bot failed: ${redact(tail(r.stderr, 300), token)}`);
  return r;
}

// Who publishes the pipeline's PRs: the bot when it is set up, else the developer (today's behavior).
// { bot, env, push(cwd, branch, { upstream }) }; `env` is the full environment for gh calls as the bot
// (undefined for the developer), and push returns git's { status, stdout, stderr }.
export async function prPublisher(config, deps = {}) {
  const bot = await resolveBot(config, deps);
  const g = deps.git ?? git;
  if (!bot) return { bot: null, env: undefined, push: (cwd, branch, { upstream = true } = {}) => g(cwd, ['push', ...(upstream ? ['-u'] : []), 'origin', branch]) };
  (deps.log ?? defaultLog)(`publishing as ${bot.name}`);
  return {
    bot: bot.name,
    env: { ...process.env, GH_TOKEN: bot.token },
    push: (cwd, branch, { upstream = true } = {}) => pushWithToken(cwd, branch, { repo: bot.repo, token: bot.token, upstream, git: g }),
  };
}

// Pushes a branch and opens its PR as the publisher. { url, reason, pushed, env }: url is null when
// the push or `gh pr create` failed (an already open PR for the branch also fails `gh pr create`).
export function openPullRequest(publisher, { cwd, branch, base, title, body }, { run: r = run } = {}) {
  const push = publisher.push(cwd, branch);
  // The pre-push QE hook prints its FAIL lines on stdout, so the reason carries both streams.
  if (push.status !== 0) return { url: null, pushed: false, env: publisher.env, reason: `push failed: ${tail(`${push.stderr ?? ''}\n${push.stdout ?? ''}`.trim(), 600)}` };
  const created = r('gh', ['pr', 'create', ...(base ? ['--base', base] : []), '--head', branch, '--title', title, '--body', body], { cwd, env: publisher.env });
  return created.status === 0
    ? { url: created.stdout.trim(), pushed: true, env: publisher.env }
    : { url: null, pushed: true, env: publisher.env, reason: `gh pr create failed: ${tail(created.stderr, 300)}` };
}

// `node bot.mjs env <root>`: prints botEnv as JSON (for botEnvSync; stdout is read by the parent only).
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url && process.argv[2] === 'env') {
  const { loadConfig } = await import('./config.mjs');
  process.stdout.write(JSON.stringify(await botEnv(loadConfig(null, process.argv[3] ?? process.cwd()))));
}
