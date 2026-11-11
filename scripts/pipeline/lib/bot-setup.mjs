// `pipeline bot setup | status`: creates the developer's PR bot, a GitHub App named `dev-bot-<login>`,
// with GitHub's manifest flow, and checks it. GitHub needs a person for two clicks: "Create GitHub App"
// on the page this opens, then "Install" on the repo. Everything else is automated: a local server on
// 127.0.0.1 posts the manifest, receives the callback, exchanges its code for the App's credentials
// and saves them outside the repo (see lib/bot.mjs), then waits for the installation.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { botName, botSettings, credentialsFile, ghLogin, installation, installationToken, loadCredentials, redact, repoOf, saveCredentials } from './bot.mjs';
import { sleep } from './util.mjs';

export const PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' };

// The App's manifest (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
export function appManifest({ name, repo, port, isPublic = false }) {
  const url = `https://github.com/${repo}`;
  return {
    name,
    url,
    description: `Opens the eShop AI pipeline's pull requests for ${repo}, so the developer can approve them.`,
    public: Boolean(isPublic),
    // No webhooks; GitHub's manifest schema still wants a URL next to `active`.
    hook_attributes: { url, active: false },
    redirect_url: `http://127.0.0.1:${port}/callback`,
    default_permissions: { ...PERMISSIONS },
    default_events: [],
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const newAppUrl = ({ org, state }) => `https://github.com/${org ? `organizations/${encodeURIComponent(org)}/` : ''}settings/apps/new?state=${state}`;

// The local page: posts the manifest to GitHub as soon as it loads.
export function manifestPage({ manifest, action }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Create ${escapeHtml(manifest.name)}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem">
<p>Sending the manifest of <b>${escapeHtml(manifest.name)}</b> to GitHub…</p>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`;
}

const page = (title, text, redirect) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${redirect ? `<meta http-equiv="refresh" content="2;url=${escapeHtml(redirect)}">` : ''}</head><body style="font-family: system-ui, sans-serif; margin: 2rem"><h1>${escapeHtml(title)}</h1><p>${text}</p></body></html>`;

export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed too.
  }
}

// Exchanges the manifest flow's code for the App: { id, slug, owner: { login }, pem, ... }.
export async function convertManifest(code, { fetch: f = globalThis.fetch } = {}) {
  const res = await f(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'eshop-pipeline-bot' },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.id || !json?.pem) throw new Error(`GitHub did not create the App: HTTP ${res.status}${json?.message ? ` (${json.message})` : ''}`);
  return json;
}

// Serves the manifest page and waits for GitHub's callback with a matching state. Resolves with the
// saved credentials ({ appId, slug, owner, file }).
export function runManifestServer({ name, repo, org, isPublic, settings, fetch: f, open = openBrowser, log, timeoutMs = 15 * 60 * 1000 }) {
  const state = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    let manifest;
    let done = false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reply = (status, html) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      };
      if (url.pathname === '/') return reply(200, manifestPage({ manifest, action: newAppUrl({ org, state }) }));
      if (url.pathname !== '/callback') return reply(404, page('Not found', ''));
      if (done) return reply(410, page('Already done', 'You can close this tab.'));
      if (url.searchParams.get('state') !== state) return reply(400, page('Wrong state', 'This callback does not belong to this setup run. Start it again with <code>pipeline bot setup</code>.'));
      const code = url.searchParams.get('code');
      if (!code) return reply(400, page('No code', 'GitHub sent no code.'));
      try {
        const app = await convertManifest(code, { fetch: f });
        const saved = { appId: app.id, slug: app.slug, owner: app.owner?.login ?? null };
        const file = saveCredentials(settings, name, { ...saved, pem: app.pem });
        done = true;
        const install = `https://github.com/apps/${app.slug}/installations/new`;
        reply(200, page(`${app.slug} created`, `Its private key is saved in ${escapeHtml(settings.credentialsDir)}. Next, install it on <b>${escapeHtml(repo)}</b>: <a href="${escapeHtml(install)}">${escapeHtml(install)}</a> (opening it now).`, install));
        server.close();
        clearTimeout(timer);
        resolve({ ...saved, file });
      } catch (error) {
        reply(500, page('Setup failed', escapeHtml(redact(error.message))));
        server.close();
        clearTimeout(timer);
        reject(error);
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for GitHub (the App was not created); run `pipeline bot setup` again'));
    }, timeoutMs);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      manifest = appManifest({ name, repo, port, isPublic });
      const local = `http://127.0.0.1:${port}/`;
      log(`Opening ${local} in your browser. On GitHub, click "Create GitHub App" (you may change the name if it is taken).`);
      log(`If the browser does not open, open ${local} yourself.`);
      open(local);
    });
  });
}

// Waits until the App is installed on the repo (polls GET /repos/{repo}/installation with its JWT).
export async function waitForInstallation(creds, repo, { fetch: f = globalThis.fetch, timeoutMs = 10 * 60 * 1000, pollMs = 5000, now = () => Date.now() } = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    const inst = await installation(creds, repo, { fetch: f, now });
    if (inst.ok) return inst;
    if (now() >= until) return inst;
    await sleep(pollMs);
  }
}

function context(config, deps) {
  const env = deps.env ?? process.env;
  const settings = botSettings(config, env);
  const login = deps.login ?? ghLogin({ env });
  const repo = deps.repo ?? repoOf(config) ?? config.tickets?.repo ?? null;
  return { env, settings, login, repo, name: login ? botName(login, settings.namePattern) : null };
}

// Returns the exit code: 0 when the bot is created, installed and can mint a token.
export async function botSetup(config, { force = false, org = null, isPublic = false } = {}, deps = {}) {
  const log = deps.log ?? ((m) => console.log(m));
  const { env, settings, login, repo, name } = context(config, deps);
  // Setup is about this developer's own App: the CI variables don't count.
  const fileEnv = { ...env, PIPELINE_BOT_APP_ID: '' };
  if (!login) {
    log('The gh CLI is not signed in. Run `gh auth login`, then this again.');
    return 1;
  }
  if (!repo) {
    log('Cannot work out the GitHub repository from the origin remote.');
    return 1;
  }
  if (!org && !isPublic && repo.split('/')[0].toLowerCase() !== login.toLowerCase()) {
    log(`Note: ${repo} is not owned by ${login}. A private App can be installed only on the account that owns it, so use --org ${repo.split('/')[0]} (an organization's admin) or --public (anyone may install it; it still acts only where installed).`);
  }
  let creds = force ? null : loadCredentials(config, { env: fileEnv, login });
  if (creds) log(`${name} is already created (App ${creds.slug ?? creds.appId}, ${creds.file}); checking its installation. Use --force to create a new one.`);
  else {
    log(`Creating the GitHub App ${name} for ${repo}. Its credentials go to ${settings.credentialsDir} (never into the repo).`);
    const saved = await runManifestServer({ name, repo, org, isPublic, settings, fetch: deps.fetch, open: deps.open ?? openBrowser, log, timeoutMs: deps.createTimeoutMs });
    log(`Created ${saved.slug} (App id ${saved.appId}); credentials saved in ${saved.file}.`);
    creds = loadCredentials(config, { env: fileEnv, login });
  }
  let inst = await installation(creds, repo, { fetch: deps.fetch });
  if (!inst.ok) {
    const install = `https://github.com/apps/${creds.slug}/installations/new`;
    log(`Now install it on ${repo}: on the page that opens, choose "Only select repositories", pick ${repo.split('/')[1]} and click "Install".`);
    log(`If the browser does not open: ${install}`);
    (deps.open ?? openBrowser)(install);
    log('Waiting for the installation (up to 10 minutes)…');
    inst = await waitForInstallation(creds, repo, { fetch: deps.fetch, timeoutMs: deps.installTimeoutMs, pollMs: deps.pollMs });
    if (!inst.ok) {
      log(`${creds.slug} is not installed on ${repo} yet. Install it at ${install}, then run \`node scripts/pipeline/pipeline.mjs bot status\`.`);
      return 1;
    }
  }
  try {
    await installationToken(config, { fetch: deps.fetch, creds, repo });
  } catch (error) {
    log(`Installed, but no token could be minted: ${redact(error.message)}`);
    return 1;
  }
  log(`Done: the pipeline's PRs on ${repo} are now opened by ${creds.slug}. You approve them with GitHub's normal review flow.`);
  return 0;
}

// Reports the bot's state; returns 0 when it is configured, installed and can mint a token.
export async function botStatus(config, deps = {}) {
  const log = deps.log ?? ((m) => console.log(m));
  const { env, settings, login, repo, name } = context(config, deps);
  const creds = loadCredentials(config, { env, login: login ?? undefined });
  const fromEnv = creds?.source === 'env';
  log(`Bot:         ${creds?.name ?? name ?? '(unknown: gh is not signed in)'}${creds?.slug ? ` (App ${creds.slug}, id ${creds.appId})` : creds ? ` (App id ${creds.appId})` : ''}`);
  log(`Enabled:     ${settings.enabled ? 'yes' : 'no (bot.enabled is false or PIPELINE_BOT=0)'}`);
  log(`Configured:  ${creds ? `yes (${fromEnv ? 'PIPELINE_BOT_APP_ID and its private key from the environment' : creds.file})` : `no (expected ${name ? credentialsFile(settings, name) : 'a credentials file'}; run \`node scripts/pipeline/pipeline.mjs bot setup\`)`}`);
  if (!creds || !repo) {
    log(`Installed:   ${repo ? 'unknown' : 'unknown (the origin remote is not on GitHub)'}`);
    log('Token:       no');
    return 1;
  }
  let inst;
  try {
    inst = await installation(creds, repo, { fetch: deps.fetch });
  } catch (error) {
    inst = { ok: false, message: redact(error.message) };
  }
  log(`Installed:   ${inst.ok ? `yes, on ${repo}` : `no, not on ${repo}${inst.status ? ` (HTTP ${inst.status})` : ''}${creds.slug ? `; install it at https://github.com/apps/${creds.slug}/installations/new` : ''}`}`);
  let token = false;
  if (inst.ok) {
    try {
      await installationToken(config, { fetch: deps.fetch, creds, repo });
      token = true;
    } catch (error) {
      log(`Token error: ${redact(error.message)}`);
    }
  }
  log(`Token:       ${token ? 'yes' : 'no'}`);
  return creds && inst.ok && token ? 0 : 1;
}
