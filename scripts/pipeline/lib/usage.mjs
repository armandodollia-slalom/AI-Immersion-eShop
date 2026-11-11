// Token usage and cost of every pipeline agent run (.agent-metrics/token-usage.jsonl), committed with the
// story like the other metrics, so it is kept long term and ties each run to its story and epic.
//
// One record per agent run and model (a run that used two models writes two records with one run_id):
// { ts, run_id, story, epic, stage, round, step, agent, agent_ver, mode, cli, model, requested_model,
//   measured, tokens: { input, output, cache_read, cache_write_5m, cache_write_1h }, requests,
//   cache_hit, cache_hit_rate, cost_usd, pricing: { model, effective, tier, rates }, cli_cost_usd,
//   premium_requests, nano_aiu, seconds, ok, timed_out }
// - tokens.input is uncached input only; cache_read and cache_write_* are the rest of the prompt.
// - cost_usd is priced from scripts/pipeline/pricing.json at the time of the run, and `pricing` keeps
//   the rates used, so later price changes never rewrite history. null when the model has no price.
// - measured is false when the CLI reported no usage (timeout, crash, custom command without a report).
import fs from 'node:fs';
import path from 'node:path';
import { metricsFile } from './state.mjs';
import { activeStory, epicOf } from './stories.mjs';
import { appendJsonl, log, nowIso, readJson, readJsonl } from './util.mjs';

export const USAGE_FILE = 'token-usage.jsonl';
export const PRICING_FILE = 'scripts/pipeline/pricing.json';

export const STAGE_OF_AGENT = {
  implementer: 'implement',
  'architecture-reviewer': 'review',
  'qe-plan': 'plan',
  'qe-plan-verifier': 'plan-verify',
  'qe-automation': 'automation',
  'qe-automation-verifier': 'automation-verify',
  'qe-lessons': 'lessons',
};

const int = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0);

// claude-haiku-5-5 and claude-haiku-5.5 are the same model; dated ids (…-4-5-20251001) drop the date.
export function normalizeModel(id) {
  if (!id) return null;
  return String(id).toLowerCase().trim().replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

const emptyModel = (model) => ({ model, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: null, cliCostUsd: null, premiumRequests: null, nanoAiu: null });

// `claude -p --output-format json`: the answer is in .result, usage per model in .modelUsage.
export function parseClaudeJson(stdout) {
  let data;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || data.type !== 'result') return null;
  const models = Object.entries(data.modelUsage ?? {}).map(([id, u]) => {
    const split = u.cacheCreationEphemeral5mInputTokens != null || u.cacheCreationEphemeral1hInputTokens != null;
    return {
      ...emptyModel(id),
      input: int(u.inputTokens),
      output: int(u.outputTokens),
      cacheRead: int(u.cacheReadInputTokens),
      cacheWrite5m: split ? int(u.cacheCreationEphemeral5mInputTokens) : int(u.cacheCreationInputTokens),
      cacheWrite1h: split ? int(u.cacheCreationEphemeral1hInputTokens) : 0,
      cliCostUsd: Number.isFinite(u.costUSD) ? u.costUSD : null,
    };
  });
  return { text: typeof data.result === 'string' ? data.result : '', models };
}

// `copilot --usage-output-file`: per-model usage, where inputTokens includes cached tokens.
export function parseCopilotUsage(data) {
  if (!data || typeof data !== 'object' || !data.modelMetrics) return null;
  const models = Object.entries(data.modelMetrics).map(([id, m]) => {
    const u = m.usage ?? {};
    const d = m.tokenDetails ?? {};
    const cacheRead = int(d.cache_read?.tokenCount ?? u.cacheReadTokens);
    const cacheWrite = int(d.cache_write?.tokenCount ?? u.cacheWriteTokens);
    return {
      ...emptyModel(id),
      input: d.input ? int(d.input.tokenCount) : Math.max(0, int(u.inputTokens) - cacheRead - cacheWrite),
      output: int(d.output?.tokenCount ?? u.outputTokens),
      cacheRead,
      cacheWrite5m: cacheWrite,
      requests: m.requests?.count ?? null,
      premiumRequests: m.requests?.cost ?? null,
      nanoAiu: m.totalNanoAiu ?? null,
    };
  });
  return { models };
}

// `codex exec --json`: one turn.completed event per turn, where input_tokens includes cached tokens.
export function parseCodexJsonl(stdout, model) {
  const usage = emptyModel(model ?? 'codex-default');
  let found = false;
  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'turn.completed' || !event.usage) continue;
    found = true;
    const cached = int(event.usage.cached_input_tokens);
    usage.cacheRead += cached;
    usage.input += Math.max(0, int(event.usage.input_tokens) - cached);
    usage.output += int(event.usage.output_tokens);
    usage.requests = (usage.requests ?? 0) + 1;
  }
  return found ? { models: [usage] } : null;
}

// A usage file written by a custom agent command (PIPELINE_USAGE_FILE): Claude's or Copilot's format, or
// { models: [{ model, input, output, cacheRead, cacheWrite5m, cacheWrite1h }] }.
export function parseUsageFile(text) {
  if (!text?.trim()) return null;
  const claude = parseClaudeJson(text);
  if (claude) return { models: claude.models };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const copilot = parseCopilotUsage(data);
  if (copilot) return copilot;
  if (Array.isArray(data?.models)) return { models: data.models.map((m) => ({ ...emptyModel(m.model), ...m })) };
  return null;
}

let pricingCache = null;
export function loadPricing(config) {
  const file = path.join(config.root, PRICING_FILE);
  if (pricingCache?.file !== file) pricingCache = { file, pricing: readJson(file, { models: {} }) };
  return pricingCache.pricing;
}

// The price in effect at `ts`: the last entry whose effective date is on or before it.
export function priceFor(pricing, model, ts) {
  const entries = pricing.models?.[normalizeModel(model)];
  if (!entries?.length) return null;
  const day = ts.slice(0, 10);
  return [...entries].filter((e) => !e.effective || e.effective <= day).sort((a, b) => (a.effective ?? '').localeCompare(b.effective ?? '')).at(-1) ?? null;
}

const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

export function costOf(pricing, usage, ts) {
  const entry = priceFor(pricing, usage.model, ts);
  if (!entry) return null;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  // The long-context tier is per request; without a request count the run is treated as one request.
  const perRequest = prompt / Math.max(1, usage.requests ?? 1);
  const long = entry.longContext && perRequest > entry.longContext.aboveInputTokens;
  const rates = Object.fromEntries(RATE_KEYS.map((k) => [k, (long ? entry.longContext[k] : undefined) ?? entry[k] ?? 0]));
  const usd = RATE_KEYS.reduce((sum, k) => sum + usage[k] * rates[k], 0) / 1e6;
  return { usd: Math.round(usd * 1e6) / 1e6, pricing: { model: normalizeModel(usage.model), effective: entry.effective ?? null, tier: long ? 'long-context' : 'standard', rates } };
}

const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export function usageRecords(config, { ctx = {}, agent, agentVer = null, mode, cli, alias = null, modelId = null, models = [], seconds = null, ok = null, timedOut = false, runId, ts = nowIso() }) {
  // Callers pass the story (null for work outside any story); otherwise it is the active story.
  const story = 'story' in ctx ? (ctx.story ?? null) : attempt(() => activeStory(config)?.key ?? null);
  const epic = story ? attempt(() => epicOf(config, story)?.key ?? null) : null;
  const common = {
    ts,
    run_id: runId,
    story,
    epic,
    stage: ctx.stage ?? STAGE_OF_AGENT[agent] ?? agent,
    round: ctx.round ?? null,
    step: ctx.step ?? null,
    agent,
    agent_ver: agentVer,
    mode,
    cli,
    requested_model: alias,
    seconds,
    ok,
    timed_out: Boolean(timedOut),
  };
  if (!models.length) {
    return [{ ...common, model: normalizeModel(modelId ?? alias), measured: false, tokens: null, requests: null, cache_hit: null, cache_hit_rate: null, cost_usd: null, pricing: null, cli_cost_usd: null, premium_requests: null, nano_aiu: null }];
  }
  const pricing = loadPricing(config);
  return models.map((u) => {
    const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    const cost = costOf(pricing, u, ts);
    return {
      ...common,
      model: normalizeModel(u.model),
      measured: true,
      tokens: { input: u.input, output: u.output, cache_read: u.cacheRead, cache_write_5m: u.cacheWrite5m, cache_write_1h: u.cacheWrite1h },
      requests: u.requests,
      cache_hit: u.cacheRead > 0,
      cache_hit_rate: prompt ? Math.round((u.cacheRead / prompt) * 1000) / 1000 : 0,
      cost_usd: cost?.usd ?? null,
      pricing: cost?.pricing ?? null,
      cli_cost_usd: u.cliCostUsd,
      premium_requests: u.premiumRequests,
      nano_aiu: u.nanoAiu,
    };
  });
}

// Never lets a usage problem break the agent run.
export function recordUsage(config, fields) {
  try {
    const records = usageRecords(config, fields);
    appendJsonl(metricsFile(config, USAGE_FILE), records);
    for (const r of records) if (r.measured && r.cost_usd == null) log(`no price for model ${r.model} in ${PRICING_FILE}; its tokens are recorded unpriced`);
    return records;
  } catch (error) {
    log(`could not record token usage: ${error.message}`);
    return [];
  }
}

export const loadUsage = (config) => readJsonl(metricsFile(config, USAGE_FILE));

export function readUsageFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    return text;
  } catch {
    return '';
  }
}
