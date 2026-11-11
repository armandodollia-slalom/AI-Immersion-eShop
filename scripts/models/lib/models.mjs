// Model allowlist for the AI pipeline: which models each agent CLI may call (project policy in
// scripts/models/config.json, narrowed by an optional gitignored config.local.json) and which models
// the CLIs installed on this machine can actually serve (discovery, cached for 24 hours).
//
// Policy functions (allowedModels, resolveModel, assertProviderUsable) are synchronous and never spawn
// anything, so the pipeline can call them on every agent run. Discovery (discoverModels,
// availableModels) is async and spawns the CLIs; its result is cached under the git common dir.
//
// Every function takes an optional last `opts` argument so tests can inject a config dir, a command
// runner, fetch, a cache file and a clock. See docs/ai-pipeline/models.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(MODELS_DIR, '..', '..');
export const PROVIDERS = ['claude', 'copilot', 'codex'];

// Claude Code has no command that lists models, and without an Anthropic API key the models API is out
// of reach (a claude.ai subscription login cannot call it). This fallback list holds ids that Claude
// Code 2.1.318 itself knows (found in its binary); it is reported with source "static".
export const STATIC_CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

export class ModelPolicyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}
export class UnknownProviderError extends ModelPolicyError {}
export class ProviderDisabledError extends ModelPolicyError {}
export class ModelNotAllowedError extends ModelPolicyError {}

// ---------------------------------------------------------------------------------------------------
// Policy

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

// Claude Code spells versions with dashes (claude-opus-5-5), Copilot CLI with dots (claude-opus-5.5).
// Both spellings name the same model, so matching compares a key with the separator removed.
export function modelKey(id) {
  const s = String(id ?? '').trim().toLowerCase();
  const m = /^(claude-[a-z]+)-(\d+)[.-](\d+)(.*)$/.exec(s);
  return m ? `${m[1]}-${m[2]}.${m[3]}${m[4]}` : s;
}

// Other spellings of an id: the dash/dot twin for claude-<family>-<major>-<minor>.
export function spellings(id) {
  const m = /^(claude-[a-z]+)-(\d+)[.-](\d+)(.*)$/.exec(id);
  if (!m) return [];
  return [`${m[1]}-${m[2]}-${m[3]}${m[4]}`, `${m[1]}-${m[2]}.${m[3]}${m[4]}`].filter((s) => s !== id);
}

const familyOf = (id) => FAMILIES.find((f) => new RegExp(`(^|-)${f}(-|$)`).test(id)) ?? null;

// Finds `requested` among `ids` by exact id, other spelling, explicit alias, or family alias ("opus"
// means the newest allowed opus). Returns the matching id from `ids` or null.
export function matchModel(ids, requested, aliases = {}) {
  if (requested == null) return null;
  const raw = String(requested).trim().toLowerCase();
  const target = aliases[raw] ?? raw;
  const key = modelKey(target);
  const hit = ids.find((id) => modelKey(id) === key);
  if (hit) return hit;
  if (FAMILIES.includes(target)) {
    const family = ids.filter((id) => familyOf(id) === target);
    return family.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0] ?? null;
  }
  return null;
}

// Loads the policy: config.json, then config.local.json may only narrow `allowed` (entries not in the
// project list are ignored with a warning) and pick a `default` among what is left.
export function loadPolicy(opts = {}) {
  const dir = opts.configDir ?? MODELS_DIR;
  const base = readJson(path.join(dir, 'config.json'));
  if (!base) throw new ModelPolicyError(`Model policy ${path.join(dir, 'config.json')} not found.`);
  const local = opts.noLocal ? null : readJson(path.join(dir, 'config.local.json'));
  const warnings = [];
  const providers = {};
  for (const [name, p] of Object.entries(base.providers ?? {})) {
    const aliases = Object.fromEntries(Object.entries(p.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let allowed = [...(p.allowed ?? [])];
    let def = p.default ?? null;
    if (def && !matchModel(allowed, def, aliases)) {
      warnings.push(`${name}: project default "${def}" is not in its allowed list; using the first allowed model`);
      def = null;
    }
    const lp = local?.providers?.[name];
    if (lp && Array.isArray(lp.allowed)) {
      const narrowed = [];
      for (const entry of lp.allowed) {
        const hit = matchModel(allowed, entry, aliases);
        if (hit) {
          if (!narrowed.includes(hit)) narrowed.push(hit);
        } else warnings.push(`${name}: config.local.json lists "${entry}", which the project policy does not allow; ignored (local config can only narrow)`);
      }
      allowed = narrowed;
    }
    if (lp?.default) {
      const hit = matchModel(allowed, lp.default, aliases);
      if (hit) def = hit;
      else warnings.push(`${name}: config.local.json default "${lp.default}" is not allowed; ignored`);
    }
    def = matchModel(allowed, def, aliases) ?? allowed[0] ?? null;
    providers[name] = { allowed, default: def, aliases };
  }
  for (const name of Object.keys(local?.providers ?? {})) {
    if (!providers[name]) warnings.push(`config.local.json: unknown provider "${name}" ignored (it cannot add providers)`);
  }
  return { providers, cacheTtlHours: base.cacheTtlHours ?? 24, warnings };
}

function providerPolicy(provider, opts) {
  const policy = opts.policy ?? loadPolicy(opts);
  const p = policy.providers[provider];
  if (!p) {
    throw new UnknownProviderError(`Unknown model provider "${provider}". Known: ${Object.keys(policy.providers).join(', ')}.`, { provider });
  }
  return p;
}

export function allowedModels(provider, opts = {}) {
  return [...providerPolicy(provider, opts).allowed];
}

export function defaultModel(provider, opts = {}) {
  return providerPolicy(provider, opts).default;
}

export function assertProviderUsable(provider, opts = {}) {
  const p = providerPolicy(provider, opts);
  if (p.allowed.length === 0) {
    throw new ProviderDisabledError(
      `no allowed models configured for ${provider}: the model policy (scripts/models/config.json) allows none of its models, so the ${provider} CLI cannot be used. Pick another agent CLI or change the policy.`,
      { provider, allowed: [] },
    );
  }
  return true;
}

// Canonical id (the provider's own spelling) for `requested`, or the provider default when it is null,
// empty or "default". Throws ModelNotAllowedError listing the allowed models otherwise.
export function resolveModel(provider, requested, opts = {}) {
  const p = providerPolicy(provider, opts);
  assertProviderUsable(provider, opts);
  if (requested == null || requested === '' || String(requested).toLowerCase() === 'default') return p.default;
  const hit = matchModel(p.allowed, requested, p.aliases);
  if (hit) return hit;
  throw new ModelNotAllowedError(
    `Model "${requested}" is not allowed for ${provider}. Allowed: ${p.allowed.join(', ')} (policy: scripts/models/config.json).`,
    { provider, requested, allowed: [...p.allowed] },
  );
}

// ---------------------------------------------------------------------------------------------------
// Discovery

export function defaultRunner(cmd, args, { timeoutMs = 30000, env = process.env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

const notFound = (r) => r.error?.code === 'ENOENT';

// `copilot help config` documents the `model` setting followed by one `- "<id>"` line per model the
// CLI knows.
export function parseCopilotHelpConfig(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^\s*`model`:/.test(l));
  if (start < 0) return [];
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+-\s+"([^"]+)"\s*$/.exec(line);
    if (!m) break;
    ids.push(m[1]);
  }
  return ids;
}

// `codex debug models` prints {"models":[{"slug": ..., "visibility": "list"|"hide", ...}]}.
export function parseCodexModels(text) {
  const json = JSON.parse(text);
  const models = Array.isArray(json) ? json : json.models;
  if (!Array.isArray(models)) throw new Error('unexpected `codex debug models` output: no models array');
  return models.filter((m) => m && m.slug).map((m) => ({ id: m.slug, hidden: m.visibility === 'hide' }));
}

const entry = (id, source, extra = {}) => ({ id, aliases: spellings(id), source, ...extra });

async function anthropicModels(env, fetchImpl) {
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const ids = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const url = `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const res = await fetchImpl(url, { headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw new Error(`Anthropic models API returned HTTP ${res.status}`);
    const body = await res.json();
    ids.push(...(body.data ?? []).map((m) => m.id));
    if (!body.has_more) break;
    after = body.last_id;
  }
  return ids;
}

const DISCOVERERS = {
  async claude({ run, env, fetchImpl }) {
    const v = run('claude', ['--version']);
    if (notFound(v)) return { installed: false, models: [], source: null, error: 'claude is not installed' };
    const version = v.stdout.trim().split('\n')[0] || null;
    const thirdParty = env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX;
    if (env.ANTHROPIC_API_KEY && !thirdParty && fetchImpl) {
      try {
        const ids = await anthropicModels(env, fetchImpl);
        return { installed: true, version, source: 'api', models: ids.map((id) => entry(id, 'api')), error: null };
      } catch (e) {
        return { installed: true, version, source: 'static', models: STATIC_CLAUDE_MODELS.map((id) => entry(id, 'static')), error: `Anthropic models API failed (${e.message}); using the static list` };
      }
    }
    return { installed: true, version, source: 'static', models: STATIC_CLAUDE_MODELS.map((id) => entry(id, 'static')), error: null };
  },
  async copilot({ run, env }) {
    const quiet = { env: { ...env, COPILOT_AUTO_UPDATE: 'false', NO_COLOR: '1' } };
    const v = run('copilot', ['--version'], quiet);
    if (notFound(v)) return { installed: false, models: [], source: null, error: 'copilot is not installed' };
    const version = v.stdout.trim().split('\n')[0] || null;
    const r = run('copilot', ['help', 'config'], quiet);
    const ids = r.status === 0 ? parseCopilotHelpConfig(r.stdout) : [];
    if (!ids.length) return { installed: true, version, source: null, models: [], error: `could not read the model list from \`copilot help config\` (exit ${r.status}) ${r.stderr.trim().slice(0, 200)}`.trim() };
    return { installed: true, version, source: 'cli', models: ids.map((id) => entry(id, 'cli')), error: null };
  },
  async codex({ run, env }) {
    const v = run('codex', ['--version'], { env });
    if (notFound(v)) return { installed: false, models: [], source: null, error: 'codex is not installed' };
    const version = v.stdout.trim().split('\n')[0] || null;
    // Without --bundled Codex refreshes the catalog for the signed-in account; when that fails, the
    // catalog bundled with the binary is still a list of ids this version understands.
    const attempts = [
      [['debug', 'models'], 'cli'],
      [['debug', 'models', '--bundled'], 'bundled'],
    ];
    const errors = [];
    for (const [args, source] of attempts) {
      const r = run('codex', args, { env, timeoutMs: 60000 });
      if (r.status !== 0) {
        errors.push(`codex ${args.join(' ')} exited ${r.status}`);
        continue;
      }
      try {
        const models = parseCodexModels(r.stdout).map((m) => entry(m.id, source, m.hidden ? { hidden: true } : {}));
        return { installed: true, version, source, models, error: errors.length ? errors.join('; ') : null };
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { installed: true, version, source: null, models: [], error: errors.join('; ') };
  },
};

export function cacheFile(opts = {}) {
  if (opts.cacheFile) return opts.cacheFile;
  if (process.env.MODELS_CACHE_FILE) return process.env.MODELS_CACHE_FILE;
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: opts.root ?? REPO_ROOT, encoding: 'utf8' });
  const dir = r.status === 0 ? path.resolve(opts.root ?? REPO_ROOT, r.stdout.trim()) : os.tmpdir();
  return path.join(dir, 'models-cache.json');
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { providers: {} };
  }
}

// {provider, installed, version, source, models:[{id, aliases, source, hidden?}], error, at, cached}.
// Results are cached per provider for cacheTtlHours; `refresh` bypasses the cache. A "not installed"
// result is never cached, so installing a CLI shows up on the next call.
export async function discoverModels(provider, { refresh = false, ...opts } = {}) {
  if (!DISCOVERERS[provider]) throw new UnknownProviderError(`Unknown model provider "${provider}".`, { provider });
  const now = opts.now ?? Date.now;
  const ttlMs = (opts.ttlHours ?? (opts.policy ?? loadPolicy(opts)).cacheTtlHours) * 3600 * 1000;
  const file = cacheFile(opts);
  const cache = readCache(file);
  const hit = cache.providers?.[provider];
  if (!refresh && hit && now() - hit.at < ttlMs) return { ...hit, cached: true };
  const run = opts.runner ?? defaultRunner;
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let result;
  try {
    result = await DISCOVERERS[provider]({ run, env, fetchImpl });
  } catch (e) {
    result = { installed: true, models: [], source: null, error: e.message };
  }
  result = { provider, version: null, ...result, at: now() };
  if (result.installed) {
    const fresh = readCache(file);
    fresh.providers = { ...(fresh.providers ?? {}), [provider]: result };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
    } catch {
      // a read-only git dir only costs a re-discovery next time
    }
  }
  return { ...result, cached: false };
}

// allowed ∩ discovered. When discovery cannot be trusted (CLI missing, discovery failed, or the list
// is static) the allowed list is returned as is with `degraded: true` and a warning.
export async function availableModels(provider, opts = {}) {
  const policy = opts.policy ?? loadPolicy(opts);
  const p = providerPolicy(provider, { policy });
  const base = { provider, allowed: [...p.allowed], default: p.default };
  const discovery = await discoverModels(provider, { ...opts, policy });
  if (p.allowed.length === 0) {
    return { ...base, models: [], disabled: true, degraded: false, warning: `no allowed models configured for ${provider}`, discovery };
  }
  if (!discovery.installed) {
    return { ...base, models: [...p.allowed], disabled: false, degraded: true, warning: `${provider} is not installed; showing the policy list unverified`, discovery };
  }
  if (!discovery.models.length) {
    return { ...base, models: [...p.allowed], disabled: false, degraded: true, warning: `could not discover ${provider} models (${discovery.error ?? 'empty list'}); showing the policy list unverified`, discovery };
  }
  const ids = discovery.models.map((m) => m.id);
  const models = p.allowed.filter((id) => matchModel(ids, id));
  const missing = p.allowed.filter((id) => !models.includes(id));
  const warnings = [];
  if (discovery.source === 'static') warnings.push(`${provider} models come from a static list (no listing command or API key); not verified against your account`);
  if (discovery.source === 'bundled') warnings.push(`${provider} models come from the catalog bundled with the CLI; not verified against your account`);
  if (missing.length) warnings.push(`allowed but not offered by the installed ${provider} CLI: ${missing.join(', ')}`);
  return {
    ...base,
    models,
    disabled: false,
    degraded: discovery.source === 'static' || discovery.source === 'bundled',
    warning: warnings.join('; ') || null,
    discovery,
  };
}

// ---------------------------------------------------------------------------------------------------
// Check: every model configured elsewhere in the repo must be allowed for the provider that runs it.

function frontMatterModel(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^model\s*:/.test(l));
  if (!line) return null;
  return line.replace(/^model\s*:\s*/, '').replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim() || null;
}

const listDir = (dir, filter) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(filter).sort() : []);

export function checkConfigs(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const policy = opts.policy ?? loadPolicy(opts);
  const problems = [];
  const checked = [];
  const rel = (f) => path.relative(root, f);

  const verify = (file, where, provider, model) => {
    checked.push({ file: rel(file), where, provider, model });
    try {
      if (!policy.providers[provider]) throw new UnknownProviderError(`unknown agent CLI "${provider}"`);
      resolveModel(provider, model, { policy });
    } catch (e) {
      problems.push({ file: rel(file), where, provider, model, message: e.message });
    }
  };
  const usable = (file, where, provider) => {
    try {
      assertProviderUsable(provider, { policy });
    } catch (e) {
      problems.push({ file: rel(file), where, provider, model: null, message: e.message });
    }
  };

  // Pipeline stage configs: scripts/pipeline/config.json is the base, scripts/<stage>/config.json and
  // the matching config.local.json files are merged on top by the pipeline.
  const scripts = path.join(root, 'scripts');
  const baseFile = path.join(scripts, 'pipeline', 'config.json');
  const base = readJson(baseFile) ?? {};
  const baseCli = base.agent?.cli ?? 'claude';
  if (fs.existsSync(baseFile)) usable(baseFile, 'agent.cli', baseCli);
  for (const stage of listDir(scripts, (d) => d !== 'models' && fs.statSync(path.join(scripts, d)).isDirectory())) {
    for (const name of ['config.json', 'config.local.json']) {
      const file = path.join(scripts, stage, name);
      const cfg = readJson(file);
      if (!cfg) continue;
      const cli = cfg.agent?.cli ?? baseCli;
      if (cfg.agent?.cli && cfg.agent.cli !== baseCli) usable(file, 'agent.cli', cfg.agent.cli);
      for (const [role, value] of Object.entries(cfg.agent?.models ?? {})) {
        if (value == null) continue;
        if (typeof value === 'object') {
          if (value.model != null) verify(file, `agent.models.${role}`, value.cli ?? cli, value.model);
        } else verify(file, `agent.models.${role}`, cli, value);
      }
      for (const [provider, classes] of Object.entries(cfg.modelClasses ?? {})) {
        for (const [cls, model] of Object.entries(classes ?? {})) {
          if (model != null) verify(file, `modelClasses.${provider}.${cls}`, provider, model);
        }
      }
      for (const [role, r] of Object.entries(cfg.implement?.roles ?? {})) {
        if (!r) continue;
        const roleCli = r.cli ?? cli;
        if (r.cli) usable(file, `implement.roles.${role}.cli`, r.cli);
        if (r.model != null) verify(file, `implement.roles.${role}.model`, roleCli, r.model);
      }
    }
  }

  // Agent definitions. .github/agents/*.agent.md are read by Copilot CLI and generated into
  // .claude/agents for Claude Code, so a model there must be allowed for both. "inherit" (use the
  // session model) is always fine.
  const agentsDir = path.join(root, '.github', 'agents');
  for (const f of listDir(agentsDir, (n) => n.endsWith('.agent.md'))) {
    const file = path.join(agentsDir, f);
    const model = frontMatterModel(fs.readFileSync(file, 'utf8'));
    if (!model || model === 'inherit') continue;
    for (const provider of ['claude', 'copilot']) verify(file, 'frontmatter model', provider, model);
  }
  const claudeAgents = path.join(root, '.claude', 'agents');
  for (const f of listDir(claudeAgents, (n) => n.endsWith('.md'))) {
    const file = path.join(claudeAgents, f);
    const model = frontMatterModel(fs.readFileSync(file, 'utf8'));
    if (model && model !== 'inherit') verify(file, 'frontmatter model', 'claude', model);
  }
  const overridesFile = path.join(scripts, 'agents-claude.json');
  for (const [agent, o] of Object.entries(readJson(overridesFile) ?? {})) {
    if (o?.model && o.model !== 'inherit') verify(overridesFile, `${agent}.model`, 'claude', o.model);
  }

  return { ok: problems.length === 0, problems, checked, warnings: policy.warnings };
}
