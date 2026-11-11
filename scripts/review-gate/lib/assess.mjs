// The triage agent (`bug-triage`, read-only, a fresh run that is not the implementer): rates each
// ticket of a published fix PR on Impact, Complexity and Fix risk from the ticket text and the PR's
// actual diff. The harness validates the result, asks once more when it is invalid, and computes
// everything else itself (severity.mjs, confidence.mjs).
import { extractResult } from '../../pipeline/lib/util.mjs';
import { normalizeLevel } from './levels.mjs';

export const TRIAGE_AGENT = 'bug-triage';
export const FIELDS = ['impact', 'complexity', 'fixRisk'];
const CATEGORIES = new Set(['auth', 'payments', 'migration', 'security']);

export function triageTask({ pr, tickets, systems, files, diff }) {
  const lines = [
    `Pull request: ${pr ?? '(not opened)'}`,
    '',
    `Systems the PR touches: ${systems.names.join(', ') || 'none'}${systems.shared ? ' (includes shared infrastructure)' : ''}${systems.contract ? ' (changes an integration-event contract)' : ''}.`,
    `Changed files (${files.length}): ${files.slice(0, 200).join(', ')}${files.length > 200 ? ', ...' : ''}`,
    '',
    `Rate each of these ${tickets.length} ticket(s): ${tickets.map((t) => t.key).join(', ')}.`,
    '',
  ];
  for (const t of tickets) lines.push(`## Ticket ${t.key}: ${t.title ?? ''}`, '', '````markdown', String(t.text ?? '').trim(), '````', '');
  lines.push('## Diff', '', '```diff', diff, '```');
  return lines.join('\n');
}

const reasonOf = (v) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 600) : null;
};

// Validates the agent's result against the tickets. Returns { tickets: Map<key, rating>, errors }.
export function parseTriage(raw, keys) {
  const errors = [];
  const out = new Map();
  if (!raw || !Array.isArray(raw.tickets)) return { tickets: out, errors: ['the result has no "tickets" list'] };
  for (const t of raw.tickets) {
    const key = String(t?.key ?? '').toUpperCase();
    if (!keys.includes(key)) {
      errors.push(`unknown ticket "${t?.key}"`);
      continue;
    }
    const rating = { key };
    for (const f of FIELDS) {
      rating[f] = normalizeLevel(t[f]);
      rating[`${f}Reason`] = reasonOf(t[`${f}Reason`]);
      if (!rating[f]) errors.push(`${key}: ${f} must be Low, Medium, High or Severe (got ${JSON.stringify(t[f] ?? null)})`);
      if (!rating[`${f}Reason`]) errors.push(`${key}: ${f}Reason is missing`);
    }
    rating.categories = (Array.isArray(t.categories) ? t.categories : []).map((c) => String(c).toLowerCase()).filter((c) => CATEGORIES.has(c));
    const conf = Number(t.confidence);
    rating.agentConfidence = Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : null;
    rating.summary = reasonOf(t.summary);
    out.set(key, rating);
  }
  for (const k of keys) if (!out.has(k)) errors.push(`${k}: no rating`);
  return { tickets: out, errors };
}

// Runs the agent (once more with the errors if the result is invalid). Never throws:
// { ratings: Map, errors, usage }. Tickets that are still invalid are left out of `ratings`.
export function runTriage(config, input, { runAgent, log = () => {} }) {
  const keys = input.tickets.map((t) => t.key);
  const settings = config.implement?.reviewGate ?? {};
  let task = triageTask(input);
  let last = { tickets: new Map(), errors: ['not run'] };
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = runAgent(config, { name: TRIAGE_AGENT, task, mode: 'read', model: config.agent?.models?.bugTriage ?? null, timeoutSec: settings.timeoutSec ?? 900, cwd: input.cwd ?? config.root, usage: { stage: 'bug-triage', story: keys[0] ?? null, step: input.pr ?? null } });
    } catch (error) {
      log(`triage agent not run: ${error.message.split('\n')[0]}`);
      return { ratings: new Map(), errors: [error.message.split('\n')[0]] };
    }
    const raw = res?.ok ? extractResult(res.output ?? '') : null;
    last = raw ? parseTriage(raw, keys) : { tickets: new Map(), errors: [res?.ok ? 'no AGENT_RESULT line' : `the agent ${res?.timedOut ? 'timed out' : `failed (exit ${res?.status})`}`] };
    if (!last.errors.length) break;
    log(`triage attempt ${attempt}: ${last.errors.join('; ')}`);
    task = `${triageTask(input)}\n\n## Your previous result was invalid\n\n${last.errors.map((e) => `- ${e}`).join('\n')}\n\nAnswer again with every ticket and every field.`;
  }
  // Keep only complete ratings: a partly rated ticket counts as not assessed.
  const ratings = new Map([...last.tickets].filter(([, r]) => FIELDS.every((f) => r[f])));
  return { ratings, errors: last.errors };
}
