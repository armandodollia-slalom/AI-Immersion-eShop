// The decision log (.agent-metrics/decisions.jsonl): why each pipeline agent decided what it did, so the
// factory retro (`qe lessons`) can improve every part of the pipeline, not just count denials.
//
// One record per decision: { ts, stage, story, round, agent, agent_ver, subject, decision, reason, items }
// - stage:    plan | plan-verify | review | automation-verify | automation
// - agent:    the agent that decided; subject: the agent whose work the decision is about
// - decision: plan-written | approved | denied | changes-requested | product-bug
// - reason:   the agent's own summary; items: per case, finding, gap or bug, each with its own `reason`
import { runTags } from './run-tags.mjs';
import { metricsFile } from './state.mjs';
import { appendJsonl, nowIso, readJsonl } from './util.mjs';

export const DECISIONS_FILE = 'decisions.jsonl';
export const REASON_MAX = 1000;
const ITEMS_MAX = 200;

export function clip(value, max = REASON_MAX) {
  if (value == null) return null;
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function cleanValue(value) {
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) return value.slice(0, ITEMS_MAX).map(cleanValue);
  if (value && typeof value === 'object') return cleanObject(value);
  return value ?? null;
}

const cleanObject = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, cleanValue(v)]));

export function decisionRecord({ stage, story, round = null, agent, agentVer = null, subject, decision, reason = null, items = [], ...extra }) {
  return cleanObject({ ts: nowIso(), stage, story, round, agent, agent_ver: agentVer, subject, decision, reason, ...extra, ...runTags(), items: items ?? [] });
}

export function logDecision(config, fields) {
  const record = decisionRecord(fields);
  appendJsonl(metricsFile(config, DECISIONS_FILE), record);
  return record;
}

export const loadDecisions = (config) => readJsonl(metricsFile(config, DECISIONS_FILE));

// Product bugs reported by qe-automation, as objects. Older string bugs ("TC-X-01: expected …, got …")
// still work: the leading case id is parsed out and the rest becomes the reason.
export function normalizeBugs(bugs) {
  return (Array.isArray(bugs) ? bugs : []).map((bug) => {
    if (bug && typeof bug === 'object') {
      const { case: id = null, expected = null, actual = null, location = null, why = null, reason = null } = bug;
      return { case: id, expected, actual, location, reason: why ?? reason };
    }
    const text = String(bug ?? '');
    const match = /^\s*(TC-[\w-]+)\s*[:\-–]\s*([\s\S]*)$/.exec(text);
    return { case: match?.[1] ?? null, expected: null, actual: null, location: null, reason: match ? match[2] : text };
  });
}

export function formatBugs(bugs) {
  return normalizeBugs(bugs)
    .map((b) => {
      const what = [b.expected && `expected ${b.expected}`, b.actual && `got ${b.actual}`].filter(Boolean).join(', ');
      const parts = [what, b.reason && (what ? `(${b.reason})` : b.reason), b.location && `at ${b.location}`].filter(Boolean);
      return `- ${b.case ? `${b.case}: ` : ''}${parts.join(' ')}`;
    })
    .join('\n');
}
