// Pure logic of the orchestrated implement flow: the orchestrator's plan (parsing and validation), the
// `owns` globs (matching, overlap, scope enforcement), dependency order, verifier verdicts and model
// classes. No I/O, so all of it is unit tested.
import { resolveModel as resolvePipelineModel } from '../../pipeline/lib/agents.mjs';
import { extractResult } from '../../pipeline/lib/util.mjs';

export const MODEL_CLASSES = ['small', 'medium', 'large'];
export const VERIFY_KINDS = ['code', 'ui'];
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ---------------------------------------------------------------------------------------------
// Parsing agent output
// ---------------------------------------------------------------------------------------------

// The plan is the `AGENT_RESULT: {...}` line; an agent that forgets the marker but ends with a fenced
// ```json block is accepted too (the last such block wins).
export function parsePlanOutput(text) {
  const marked = extractResult(text ?? '');
  if (marked) return marked;
  const blocks = [...String(text ?? '').matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  for (const block of blocks.reverse()) {
    try {
      return JSON.parse(block[1]);
    } catch {
      // try the previous block
    }
  }
  return null;
}

// A verifier ends with `AGENT_RESULT: {"verdict": "APPROVED|CHANGES_REQUESTED", "summary", "findings": [...]}`.
// Every blocking finding names a file (and a line for code, or a screenshot for UI checks); a verdict
// that breaks the contract is null so the caller asks again.
export function parseVerdict(text, { ui = false } = {}) {
  const raw = extractResult(text ?? '');
  if (!raw || !['APPROVED', 'CHANGES_REQUESTED'].includes(raw.verdict)) return null;
  if (raw.findings != null && !Array.isArray(raw.findings)) return null;
  // A design finding's app screenshot (`actual`) is its screenshot when the verifier gave no other.
  const findings = (raw.findings ?? []).map((f) => ({ ...f, ...(ui && typeof f?.actual === 'string' && typeof f?.screenshot !== 'string' ? { screenshot: f.actual } : {}), severity: f?.severity === 'minor' ? 'minor' : 'blocking' }));
  const blocking = findings.filter((f) => f.severity === 'blocking');
  for (const f of blocking) {
    if (typeof f.issue !== 'string' || !f.issue.trim()) return null;
    if (ui ? !(typeof f.screenshot === 'string' || typeof f.file === 'string') : typeof f.file !== 'string') return null;
  }
  const verdict = blocking.length ? 'CHANGES_REQUESTED' : raw.verdict === 'CHANGES_REQUESTED' ? null : 'APPROVED';
  if (!verdict) return null; // changes requested without a single blocking finding
  return { verdict, summary: String(raw.summary ?? ''), findings, ...(Array.isArray(raw.disputes) ? { disputes: raw.disputes } : {}) };
}

export function formatFindings(findings) {
  return findings
    .map((f, i) => {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : '';
      const design = [f.mockup && `Mockup: ${f.mockup}`, f.actual && `Actual: ${f.actual}`, f.diff && `Pixel diff (evidence only): ${f.diff}`].filter(Boolean).map((l) => `\n   ${l}`).join('');
      const shot = `${f.screenshot && f.screenshot !== f.actual ? `\n   Screenshot: ${f.screenshot}` : ''}${design}`;
      const detail = f.detail ? `\n   ${String(f.detail).split('\n').join('\n   ')}` : '';
      const tag = `${f.id ? `[id ${f.id}] ` : ''}${f.category === 'design' ? '[design] ' : ''}`;
      const again = f.reasserted ? `\n   Re-asserted after your dispute (${f.reasserted}x): ${f.evidence ?? ''}${f.reasserted >= 2 ? ' It can no longer be disputed: fix it, or report blocked.' : ''}` : '';
      return `${i + 1}. [${f.severity ?? 'blocking'}] ${tag}${where}${f.issue ?? ''}${f.fix ? `\n   Fix: ${f.fix}` : ''}${again}${shot}${detail}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Globs: `*` and `?` stay inside one path segment, `**` crosses segments, `dir/**/x` also matches
// `dir/x`. A pattern without wildcards matches that path and everything under it.
// ---------------------------------------------------------------------------------------------

const normalizeGlob = (glob) => String(glob).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

function alternatives(glob) {
  const g = normalizeGlob(glob);
  const base = /[*?]/.test(g) ? [g] : [g, `${g}/**`];
  // Expand each `**/` into "nothing" or "** then /" so the token form needs no zero-directory case.
  const out = [];
  const expand = (s) => {
    const i = s.indexOf('**/');
    if (i < 0 || out.length > 64) return out.push(s);
    expand(s.slice(0, i) + s.slice(i + 3));
    expand(`${s.slice(0, i)}\u0000/${s.slice(i + 3)}`);
  };
  for (const b of base) expand(b);
  // eslint-disable-next-line no-control-regex -- \u0000 marks an expanded `**/` above
  return out.map((s) => s.replace(/\u0000/g, '**'));
}

function tokens(alt) {
  const out = [];
  for (let i = 0; i < alt.length; i++) {
    if (alt[i] === '*' && alt[i + 1] === '*') {
      out.push({ t: 'GS' });
      i++;
    } else if (alt[i] === '*') out.push({ t: 'S' });
    else if (alt[i] === '?') out.push({ t: 'Q' });
    else out.push({ t: 'L', c: alt[i] });
  }
  return out;
}

const regexFor = (alt) =>
  new RegExp(
    `^${tokens(alt)
      .map((tok) => (tok.t === 'GS' ? '.*' : tok.t === 'S' ? '[^/]*' : tok.t === 'Q' ? '[^/]' : tok.c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
  );

export function matchGlob(file, glob) {
  const f = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  return alternatives(glob).some((alt) => regexFor(alt).test(f));
}

export const matchesAny = (file, globs) => globs.some((g) => matchGlob(file, g));

// Whether some path matches both token lists: a search over pairs of positions.
function intersects(a, b) {
  const seen = new Set();
  const stack = [[0, 0]];
  const wild = (tok) => tok && (tok.t === 'S' || tok.t === 'GS');
  while (stack.length) {
    const [i, j] = stack.pop();
    const k = `${i},${j}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (i === a.length && j === b.length) return true;
    if (wild(a[i])) stack.push([i + 1, j]);
    if (wild(b[j])) stack.push([i, j + 1]);
    const x = a[i];
    const y = b[j];
    if (!x || !y) continue;
    let ok;
    if (x.t === 'L' && y.t === 'L') ok = x.c === y.c;
    else if (x.t === 'L') ok = y.t === 'GS' || x.c !== '/';
    else if (y.t === 'L') ok = x.t === 'GS' || y.c !== '/';
    else ok = true; // two wildcards always share some non-slash character
    if (!ok) continue;
    stack.push([x.t === 'L' || x.t === 'Q' ? i + 1 : i, y.t === 'L' || y.t === 'Q' ? j + 1 : j]);
  }
  return false;
}

export function globsOverlap(g1, g2) {
  for (const a of alternatives(g1)) for (const b of alternatives(g2)) if (intersects(tokens(a), tokens(b))) return true;
  return false;
}

// Changed files outside the subtask's `owns`.
export const scopeViolations = (files, owns) => files.filter((f) => !matchesAny(f, owns));

// ---------------------------------------------------------------------------------------------
// Stories and plans
// ---------------------------------------------------------------------------------------------

// A UI story changes the Blazor storefront: an `[FE - ...]` title, WebApp/WebAppComponents/Blazor in the
// title's component list, or a `.razor` file named anywhere in the story.
export function isUiStory(text) {
  const title = /^#\s+(.+)$/m.exec(text ?? '')?.[1] ?? '';
  if (/\[FE\b/.test(title)) return true;
  const components = /\[[A-Z]{2}\s*-\s*([^\]]+)\]/.exec(title)?.[1] ?? '';
  if (/\b(WebApp|WebAppComponents|Blazor)\b/.test(components)) return true;
  return /\b[\w./-]+\.razor\b/.test(text ?? '');
}

// Plan order with every subtask after the ones it depends on (stable otherwise).
export function topoOrder(subtasks) {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const out = [];
  const mark = new Map();
  const visit = (s, trail) => {
    if (mark.get(s.id) === 'done') return;
    if (mark.get(s.id) === 'visiting') throw new Error(`dependency cycle: ${[...trail, s.id].join(' -> ')}`);
    mark.set(s.id, 'visiting');
    for (const d of s.dependsOn ?? []) if (byId.has(d)) visit(byId.get(d), [...trail, s.id]);
    mark.set(s.id, 'done');
    out.push(s);
  };
  for (const s of subtasks) visit(s, []);
  return out;
}

const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Self mode: the orchestrator implements the whole story as one implicit subtask that owns everything.
export function selfSubtask(plan, { uiStory }) {
  const given = Array.isArray(plan.subtasks) ? plan.subtasks[0] ?? {} : {};
  return {
    id: 'self',
    goal: nonEmptyString(given.goal) ? given.goal : 'Implement the whole story.',
    acceptance: Array.isArray(given.acceptance) && given.acceptance.length ? given.acceptance : ['Every acceptance criterion of the story'],
    owns: ['**'],
    dependsOn: [],
    modelClass: 'large',
    verify: given.verify === 'ui' && uiStory ? 'ui' : 'code',
    scenario: given.scenario ?? null,
    self: true,
  };
}

// Validates the orchestrator's plan against the harness limits. Returns { ok, errors, fatal, plan }:
// `fatal` errors (too many subtasks) fail the story without asking again; the others go back to the
// orchestrator once. `plan` is the normalized plan when ok.
export function validatePlan(raw, { storyText = '', limits = {} } = {}) {
  const { maxSubtasks = 4, maxLargeSubtasks = 1 } = limits;
  const errors = [];
  const fatal = [];
  const detectedUi = isUiStory(storyText);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the plan is not a JSON object'], fatal: [], plan: null };
  if (!['delegate', 'self'].includes(raw.mode)) errors.push('`mode` must be "delegate" or "self"');
  if (raw.uiStory === true && !detectedUi) errors.push('`uiStory` is true but the story is not a UI story (no [FE] tag, no WebApp/WebAppComponents/Blazor in the title, no .razor file named)');
  const uiStory = detectedUi;

  if (!nonEmptyString(raw.modeReason)) errors.push('`modeReason` is required: one short sentence on why delegate or self');
  const features = raw.features && typeof raw.features === 'object' ? raw.features : {};
  if (features.estimatedSize != null && !MODEL_CLASSES.includes(features.estimatedSize)) errors.push('`features.estimatedSize` must be small, medium or large');
  const planDecision = {
    modeReason: raw.modeReason ?? null,
    splitReason: raw.splitReason ?? null,
    features: { services: Array.isArray(features.services) ? features.services : null, estimatedSize: features.estimatedSize ?? null },
  };

  if (raw.mode === 'self') {
    if (Array.isArray(raw.subtasks) && raw.subtasks.length > 1) errors.push('self mode takes at most one subtask entry (its goal, acceptance and verify)');
    const st = selfSubtask(raw, { uiStory });
    if (raw.subtasks?.[0]?.verify === 'ui' && !uiStory) errors.push('verify "ui" is only allowed for UI stories');
    st.decision = decisionFields(raw.subtasks?.[0] ?? {}, null);
    return { ok: !errors.length, errors, fatal, plan: errors.length ? null : { mode: 'self', uiStory, subtasks: [st], notes: raw.notes ?? null, decision: planDecision } };
  }
  if (!nonEmptyString(raw.splitReason)) errors.push('`splitReason` is required in delegate mode: one short sentence on why the story splits this way');

  const subtasks = Array.isArray(raw.subtasks) ? raw.subtasks : null;
  if (!subtasks || !subtasks.length) {
    errors.push('`subtasks` must be a non-empty array');
    return { ok: false, errors, fatal, plan: null };
  }
  if (subtasks.length > maxSubtasks) {
    fatal.push(`split the story: the plan has ${subtasks.length} subtasks and at most ${maxSubtasks} are allowed`);
    return { ok: false, errors: [...fatal, ...errors], fatal, plan: null };
  }

  const ids = new Set();
  const norm = [];
  subtasks.forEach((s, i) => {
    const at = `subtask ${s?.id ?? `#${i + 1}`}`;
    if (!s || typeof s !== 'object') return errors.push(`subtask #${i + 1} is not an object`);
    if (!ID.test(s.id ?? '')) errors.push(`${at}: \`id\` must match ${ID} (lowercase letters, digits, dashes)`);
    else if (ids.has(s.id)) errors.push(`${at}: duplicate id`);
    ids.add(s.id);
    if (!nonEmptyString(s.goal)) errors.push(`${at}: \`goal\` is required`);
    if (!Array.isArray(s.acceptance) || !s.acceptance.length || !s.acceptance.every(nonEmptyString)) errors.push(`${at}: \`acceptance\` must be a non-empty list of strings`);
    if (!Array.isArray(s.owns) || !s.owns.length || !s.owns.every(nonEmptyString)) errors.push(`${at}: \`owns\` must be a non-empty list of path globs`);
    else
      for (const g of s.owns) {
        const n = normalizeGlob(g);
        if (n.startsWith('/') || n.split('/').includes('..')) errors.push(`${at}: owns "${g}" must be relative to the repo root, without ".."`);
        if (n === '**' || n === '' || n === '*') errors.push(`${at}: owns "${g}" covers the whole repo; use self mode instead`);
      }
    if (s.dependsOn != null && (!Array.isArray(s.dependsOn) || !s.dependsOn.every((d) => typeof d === 'string'))) errors.push(`${at}: \`dependsOn\` must be a list of subtask ids`);
    if (!MODEL_CLASSES.includes(s.modelClass)) errors.push(`${at}: \`modelClass\` must be one of ${MODEL_CLASSES.join(', ')}`);
    if (s.modelClass === 'large' && !nonEmptyString(s.justification)) errors.push(`${at}: modelClass "large" needs a \`justification\``);
    // An explicit model alias (for example "sol" on Copilot) overrides the class; it must be allowed.
    if (s.model != null && (!nonEmptyString(s.model) || (limits.allowedModels && !limits.allowedModels.includes(s.model)))) errors.push(`${at}: \`model\` must be one of the allowed models (${(limits.allowedModels ?? []).join(', ') || 'agent.allowedModels'}) or left out`);
    if (!VERIFY_KINDS.includes(s.verify)) errors.push(`${at}: \`verify\` must be "code" or "ui"`);
    if (s.verify === 'ui' && !uiStory) errors.push(`${at}: verify "ui" is only allowed for UI stories`);
    if (s.scenario != null && !nonEmptyString(s.scenario)) errors.push(`${at}: \`scenario\` must be a teststack scenario name`);
    decisionFields(s, (e) => errors.push(`${at}: ${e}`));
    norm.push({
      id: s.id,
      goal: s.goal,
      acceptance: s.acceptance,
      owns: s.owns,
      dependsOn: s.dependsOn ?? [],
      modelClass: s.modelClass,
      ...(s.model ? { model: s.model } : {}),
      verify: s.verify,
      justification: s.justification ?? null,
      scenario: s.scenario ?? null,
      decision: decisionFields(s, null),
    });
  });

  const large = norm.filter((s) => s.modelClass === 'large');
  if (large.length > maxLargeSubtasks) errors.push(`at most ${maxLargeSubtasks} subtask(s) may use modelClass "large" (got ${large.map((s) => s.id).join(', ')})`);

  for (const s of norm) for (const d of s.dependsOn) if (!ids.has(d) || d === s.id) errors.push(`subtask ${s.id}: dependsOn "${d}" is not another subtask`);
  errors.push(...ownsOverlaps(norm));
  if (!errors.length) {
    try {
      topoOrder(norm);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: !errors.length, errors, fatal, plan: errors.length ? null : { mode: 'delegate', uiStory, subtasks: norm, notes: raw.notes ?? null, decision: planDecision } };
}

// The orchestrator's reasoning and expectations for one subtask, kept for the decision log only (never
// shown to verifiers). With `report`, missing or malformed fields are reported as errors.
export function decisionFields(s, report) {
  const err = report ?? (() => {});
  if (!nonEmptyString(s.modelReason)) err('`modelReason` is required (one short sentence)');
  if (!nonEmptyString(s.verifyReason)) err('`verifyReason` is required (one short sentence)');
  if (!Number.isInteger(s.expectedFiles) || s.expectedFiles < 0) err('`expectedFiles` must be a whole number');
  if (!Number.isInteger(s.expectedLoc) || s.expectedLoc < 0) err('`expectedLoc` must be a whole number (lines added plus removed)');
  if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1) err('`confidence` must be a number from 0 to 1');
  if (!Array.isArray(s.alternatives)) err('`alternatives` must be a list (may be empty) of {"option", "reason"}');
  return {
    modelReason: s.modelReason ?? null,
    verifyReason: s.verifyReason ?? null,
    expectedFiles: Number.isInteger(s.expectedFiles) ? s.expectedFiles : null,
    expectedLoc: Number.isInteger(s.expectedLoc) ? s.expectedLoc : null,
    confidence: typeof s.confidence === 'number' ? s.confidence : null,
    alternatives: Array.isArray(s.alternatives) ? s.alternatives.slice(0, 5).map((a) => (typeof a === 'string' ? { option: a, reason: null } : { option: a?.option ?? null, reason: a?.reason ?? null })) : [],
  };
}

// One error per pair of subtasks whose `owns` globs can match the same file.
export function ownsOverlaps(subtasks) {
  const errors = [];
  for (let i = 0; i < subtasks.length; i++)
    for (let j = i + 1; j < subtasks.length; j++)
      for (const a of subtasks[i].owns ?? [])
        for (const b of subtasks[j].owns ?? [])
          if (globsOverlap(a, b)) errors.push(`subtasks ${subtasks[i].id} and ${subtasks[j].id} both own files matching "${a}" / "${b}"; give every file one owner`);
  return [...new Set(errors)];
}

// ---------------------------------------------------------------------------------------------
// Models and CLIs
// ---------------------------------------------------------------------------------------------

// The CLI a role runs on: `implement.roles.<role>.cli`, else the pipeline's agent CLI.
export const roleCli = (config, role) => config.implement?.roles?.[role]?.cli || config.agent.cli;

// The model alias for a model class (`modelClasses` in scripts/implement/config.json maps small, medium
// and large to aliases from agent.allowedModels). It is checked against the role's CLI here, through the
// pipeline's one model check (resolveModel in scripts/pipeline/lib/agents.mjs), so a plan that needs a
// model the CLI may not run (a disallowed alias, or Codex, which has no allowed model ids) fails at plan
// validation instead of halfway through the story. runAgent maps the alias to the CLI's own id.
export function resolveModel(config, role, modelClass) {
  const alias = config.modelClasses?.[modelClass] ?? config.agent.models?.default ?? null;
  if (!config.agent.cmd) resolvePipelineModel(config, alias, roleCli(config, role));
  return alias;
}

// THE place the implement harness picks a model for an agent run: every orchestrator, pair and verifier
// run goes through here. The orchestrator uses `agent.models.implementer` when set, else its role's
// model class; other roles use the class they are given (planner's choice, or the verifier's fixed one).
export function resolveModelForRole(config, role, modelClass = null, explicit = null) {
  // A subtask's explicit `model` alias (the planner's choice, e.g. sol) wins over its class.
  if (explicit) {
    if (!config.agent.cmd) resolvePipelineModel(config, explicit, roleCli(config, role));
    return explicit;
  }
  if (role === 'orchestrator') {
    const pinned = config.agent.models?.implementer;
    if (pinned) {
      if (!config.agent.cmd) resolvePipelineModel(config, pinned, roleCli(config, role));
      return pinned;
    }
    return resolveModel(config, role, config.implement?.roles?.orchestrator?.modelClass ?? 'large');
  }
  return resolveModel(config, role, modelClass ?? config.implement?.roles?.[role]?.modelClass ?? 'medium');
}

// A subtask the orchestrator rewrote after an escalation: the same checks as a plan, against the
// subtasks it must not overlap. Its reasoning fields carry over from the original when not given.
export function validateRewrite(original, proposed, others, { storyText = '', limits = {} } = {}) {
  const allowed = ['goal', 'acceptance', 'owns', 'modelClass', 'model', 'justification', 'verify', 'scenario', 'modelReason', 'verifyReason', 'expectedFiles', 'expectedLoc', 'confidence', 'alternatives'];
  const flat = (s) => ({ ...s, ...(s.decision ?? {}), dependsOn: [] });
  const candidate = { ...flat(original), ...Object.fromEntries(Object.entries(proposed ?? {}).filter(([k]) => allowed.includes(k))), id: original.id };
  const v = validatePlan(
    { mode: 'delegate', modeReason: '-', splitReason: '-', subtasks: [candidate, ...others.map(flat)] },
    { storyText, limits: { ...limits, maxSubtasks: Infinity, maxLargeSubtasks: Infinity } },
  );
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, subtask: { ...v.plan.subtasks[0], dependsOn: original.dependsOn ?? [] } };
}
