// Pure logic of epic delivery (no I/O, unit tested): the epic plan task and its design note (parsing,
// validation, Markdown), story scheduling inside an epic (Blocked-by order, cross-story `owns`
// serialization), the cross-story journey ticket for the epic-level QE, and the epic PR body.
// The runner is lib/epic.mjs; see docs/ai-pipeline/implement.md#epic-delivery.
import { globsOverlap } from './plan.mjs';

const fence = (text, lang = '') => `\`\`\`\`${lang}\n${String(text ?? '').replace(/\r\n/g, '\n').trimEnd()}\n\`\`\`\``;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const EPIC_PLAN_STAGE = 'implement-epic-plan';

// `epic-promotions` -> `promotions`, the slug of the epic branch and worktree.
export const epicSlug = (epicKey) =>
  String(epicKey)
    .toLowerCase()
    .replace(/^epic-/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');

// The story key the epic-level QE plan and tests use: `EPIC-<issue number>` (test ids `TC-EPIC-<n>-NN`),
// so the QE stage, its case-id checks and the PR check treat the cross-story journeys like a story.
// Without an issue (an offline cache) a stable number from the epic key stands in.
export function epicTestKey(epicKey, number = null) {
  if (Number.isInteger(number) && number > 0) return `EPIC-${number}`;
  let h = 0;
  for (const c of String(epicKey)) h = (h * 31 + c.charCodeAt(0)) % 90000;
  return `EPIC-${10000 + h}`;
}

// ---------------------------------------------------------------------------------------------
// Bug epics: PR groups
// ---------------------------------------------------------------------------------------------

export const GROUPINGS = ['auto', 'epic', 'ticket'];
export const isBugTicket = (t) => t?.type === 'bug' || /^BUG-\d+$/i.test(t?.key ?? '');

// How an epic is delivered: "epic" (one branch and one PR) or "groups" (bug epics: the orchestrator
// groups the tickets into PRs). `grouping` auto picks groups when most tickets are bugs; "ticket" is one
// PR per ticket without asking the orchestrator; "epic" forces one PR.
export function deliveryShape(tickets, grouping = 'auto') {
  if (grouping === 'epic') return { kind: 'epic' };
  if (grouping === 'ticket') return { kind: 'groups', planned: false };
  const bugs = tickets.filter(isBugTicket).length;
  return bugs > 0 && bugs * 2 > tickets.length ? { kind: 'groups', planned: true } : { kind: 'epic' };
}

// One PR per ticket, in Blocked-by order: the fallback when the orchestrator's grouping stays invalid,
// and `--grouping ticket`.
export const singleGroups = (stories) => stories.map((s) => ({ id: s.key.toLowerCase(), title: s.title ?? s.key, tickets: [s.key], reason: 'one PR per ticket', risk: null }));

// A ticket's in-epic prerequisites for grouping: its Blocked-by tickets plus the design note's dependsOn.
const prerequisites = (story, note) => [...new Set([...(story?.blockedBy ?? []), ...((note?.stories ?? []).find((n) => n.key === story?.key)?.dependsOn ?? [])])];

// Validates the orchestrator's PR groups: every ticket in exactly one group, at most `maxPerGroup`
// tickets per group (only when a positive cap is configured; none by default), and a ticket's Blocked-by
// tickets (and the note's dependsOn) in the same group or an earlier one.
export function validateGroups(raw, { stories, maxPerGroup = null, note = null }) {
  const errors = [];
  const known = new Map(stories.map((s) => [s.key, s]));
  const seen = new Map();
  const groups = [];
  const ids = new Set();
  if (!Array.isArray(raw) || !raw.length) return { ok: false, errors: ['prGroups is required for a bug epic: give every ticket exactly one group'], groups: [] };
  raw.forEach((g, i) => {
    const id = String(g?.id ?? '');
    if (!ID.test(id)) errors.push(`prGroups[${i}].id "${id}" must be [a-z0-9-]`);
    else if (ids.has(id)) errors.push(`prGroups: id "${id}" is used twice`);
    ids.add(id);
    const tickets = strings(g?.tickets).map((k) => k.toUpperCase());
    if (!tickets.length) errors.push(`prGroups.${id}: no tickets`);
    if (maxPerGroup > 0 && tickets.length > maxPerGroup) errors.push(`prGroups.${id}: ${tickets.length} tickets, more than maxBugsPerGroup (${maxPerGroup}); split it`);
    for (const k of tickets) {
      if (!known.has(k)) errors.push(`prGroups.${id}: "${k}" is not a ticket of this epic`);
      else if (seen.has(k)) errors.push(`prGroups: ${k} is in both ${seen.get(k)} and ${id}; every ticket belongs to exactly one group`);
      else seen.set(k, id);
    }
    groups.push({ id, title: String(g?.title ?? id), tickets: tickets.filter((k) => known.has(k)), reason: typeof g?.reason === 'string' ? g.reason : null, risk: typeof g?.risk === 'string' ? g.risk : null });
  });
  for (const k of known.keys()) if (!seen.has(k)) errors.push(`prGroups: ${k} is in no group`);
  const index = new Map(groups.map((g, i) => [g.id, i]));
  for (const g of groups) {
    for (const k of g.tickets) {
      for (const b of prerequisites(known.get(k), note)) {
        if (!seen.has(b)) continue;
        if (index.get(seen.get(b)) > index.get(g.id)) errors.push(`prGroups.${g.id}: ${k} is blocked by (or dependsOn) ${b}, which is in the later group ${seen.get(b)}; put ${b} in the same or an earlier group`);
      }
    }
  }
  return { ok: !errors.length, errors, groups };
}

// The groups each group waits for (and stacks on): those holding a Blocked-by ticket, or a ticket the
// design note says it dependsOn, of one of its tickets.
export function groupDeps(groups, stories, note = null) {
  const of = new Map(groups.flatMap((g) => g.tickets.map((k) => [k, g.id])));
  const byKey = new Map(stories.map((s) => [s.key, s]));
  return new Map(groups.map((g) => [g.id, [...new Set(g.tickets.flatMap((k) => prerequisites(byKey.get(k) ?? { key: k }, note).map((b) => of.get(b)).filter((x) => x && x !== g.id)))]]));
}

// The decision log record of the grouping (stage implement-epic-plan, decision pr-groups).
export const groupsDecision = ({ epic, groups, decisionId = null, fallback = null, agent = {} }) => ({
  stage: EPIC_PLAN_STAGE,
  story: epic.key,
  round: null,
  agent: 'implementer',
  agentVer: agent.version ?? null,
  subject: 'implementer',
  decision: 'pr-groups',
  reason: fallback ?? `${groups.length} PR group(s)`,
  decision_id: decisionId,
  fallback: Boolean(fallback),
  items: groups.map((g) => ({ id: g.id, title: g.title, tickets: g.tickets, reason: g.reason, risk: g.risk })),
});

// The per-group outcome (decision-outcomes, type pr-group) the retro judges the grouping by.
export const groupOutcome = ({ ts, epic, decisionId, group, results, pr, outcome, costUsd = null, mergeConflicts = 0 }) => ({
  ts,
  type: 'pr-group',
  epic: epic.key,
  decisionId,
  groupId: group.id,
  tickets: group.tickets,
  verified: group.tickets.filter((k) => results[k]?.outcome === 'done').length,
  failed: group.tickets.filter((k) => results[k] && !['done', 'skipped'].includes(results[k].outcome)),
  skipped: group.tickets.filter((k) => results[k]?.outcome === 'skipped'),
  pr: pr ?? null,
  outcome,
  cost_usd: costUsd,
  mergeConflicts,
});

const groupsSchema = `,
  "prGroups": [{ "id": "<a-z0-9->", "title": "<what the PR fixes>", "tickets": ["BUG-1", "BUG-7"], "reason": "<why these ship together>", "risk": "low" | "medium" | "high" }]`;

export const noteSchema = `{
  "summary": "<two or three sentences: what the epic builds and how the stories fit together>",
  "contracts": [{ "name": "<API route, DTO, interface or table>", "kind": "api" | "dto" | "interface" | "db" | "config", "definition": "<shape, one line or a short block>", "owner": "<KEY or foundation>", "usedBy": ["<KEY>"] }],
  "migrations": [{ "name": "<migration>", "service": "<service>", "owner": "<KEY or foundation>" }],
  "components": [{ "name": "<class or Razor component>", "path": "<file>", "owner": "<KEY or foundation>", "usedBy": ["<KEY>"] }],
  "events": [{ "name": "<integration event>", "publisher": "<KEY or service>", "subscribers": ["<KEY or service>"] }],
  "foundation": null | { "goal": "<what every story needs first>", "acceptance": ["<checkable result>"], "owns": ["<glob>"], "reason": "<why it must come first>" },
  "stories": [{ "key": "<KEY>", "owns": ["<glob of the files this story changes>"], "dependsOn": ["<KEY that must be merged first, beyond Blocked by>"], "notes": "<what this story must reuse or leave to others>" }],
  "buildOrder": ["<KEY>", "..."],
  "journeys": [{ "id": "<a-z0-9->", "title": "<cross-story user journey>", "stories": ["<KEY>", "<KEY>"], "steps": ["<step>"], "expected": "<observable result>" }],
  "risks": ["<optional>"]
}`;

// The orchestrator's task in EPIC PLAN mode (read mode, every ticket of the epic inline).
export function epicPlanTask({ epic, stories, mockups = [], errors = null, groups = false, maxPerGroup = null }) {
  const lines = [
    `Plan epic ${epic.key}: ${epic.title}`,
    '',
    'You are the orchestrator, running headless under `pipeline implement` in EPIC PLAN mode: read the epic, every story of it and the code (graphify first), then write the epic design note. Do not edit files.',
    '',
    'The epic is delivered as ONE branch: each story runs the usual flow (your story plan, verifier pairs, architecture review, QE) on a story branch from the epic branch, and is merged into the epic branch once its tests verify. Every story orchestrator gets this note, so decide once what the stories share:',
    '- shared contracts (API routes, DTOs, interfaces, tables), migrations, components and integration events, each with ONE owner (a story key, or `foundation`);',
    '- an optional **foundation**: shared groundwork several stories need first (a migration, a shared DTO, a common component). It runs before any story, implemented by you and checked by a verifier. Leave it null when the stories do not share groundwork; keep it small;',
    '- per story, the files it will change (`owns` globs). Stories whose owns overlap never run at the same time; dependsOn adds ordering beyond the stories\' Blocked by lines;',
    '- the build order, and the cross-story user **journeys** (a shopper path that crosses two or more stories) that the epic-level end-to-end tests will cover.',
    '',
    'Rules the harness enforces: `stories` uses only the keys below; foundation `owns` is non-empty when there is a foundation; journey ids are unique [a-z0-9-] and name only keys below; no dependency cycles.',
    ...(groups
      ? [
          '',
          'This is a **bug epic**: its tickets are not delivered as one PR. Decide which bug tickets ship together as one PR (`prGroups`); each group gets its own branch from the base, its tickets run the usual per-ticket flow and merge into it, and the group gets one PR. Guidance:',
          '- group tickets that share a service or area, change overlapping files, share a root cause, or depend on each other (a Blocked-by or dependsOn ticket goes in the same group or an earlier one; a group that needs another group\'s tickets waits for that group\'s PR and is stacked on its branch, and is skipped if it fails, so add a cross-group dependsOn only when a fix really needs the other fix);',
          `- keep each PR reviewable: a reviewer should be able to follow the whole group (a judgement call${maxPerGroup > 0 ? `; the harness allows at most ${maxPerGroup} tickets per group` : ''}); a single-ticket group is fine;`,
          '- keep unrelated or risky fixes separate: a security or data fix ships alone; one failing ticket holds back its whole group, so do not group risky fixes with easy ones;',
          '- every ticket in exactly one group. Leave `foundation` null and `journeys` empty unless a journey really crosses tickets.',
        ]
      : []),
    '',
    `End your reply with exactly one line \`AGENT_RESULT: <note JSON on one line>\`, where the note follows this shape (comments are explanations, not JSON):`,
    '',
    fence(groups ? noteSchema.replace(/\n}$/, `${groupsSchema}\n}`) : noteSchema, 'jsonc'),
    '',
    `### Epic ${epic.key}`,
    '',
    fence(epic.text ?? '(no epic body)', 'markdown'),
  ];
  for (const s of stories) lines.push('', `### Story ${s.key}${s.blockedBy?.length ? ` (blocked by ${s.blockedBy.join(', ')})` : ''}`, '', fence(s.text ?? '', 'markdown'));
  if (mockups.length) lines.push('', '### Mockups', '', ...mockups.map((m) => `- ${m}`));
  if (errors?.length) lines.push('', 'Your previous note was rejected. Fix these problems and return the whole note again:', '', ...errors.map((e) => `- ${e}`));
  return lines.join('\n');
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

// Validates the design note against the epic's stories. Returns { ok, note, errors }; a valid note is
// normalized (every story present, unknown fields dropped).
export function validateNote(raw, { keys, groups = false, stories: tickets = null, maxPerGroup = null }) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['no design note found: end your reply with `AGENT_RESULT: <note JSON on one line>`'] };
  const known = new Set(keys);
  const stories = new Map(keys.map((k) => [k, { key: k, owns: [], dependsOn: [], notes: null }]));
  for (const s of arr(raw.stories)) {
    const key = String(s.key ?? '').toUpperCase();
    if (!known.has(key)) {
      errors.push(`stories: "${s.key}" is not a story of this epic (${keys.join(', ')})`);
      continue;
    }
    const deps = strings(s.dependsOn).map((d) => d.toUpperCase());
    for (const d of deps) if (!known.has(d) || d === key) errors.push(`stories.${key}.dependsOn: "${d}" is not another story of this epic`);
    stories.set(key, { key, owns: strings(s.owns), dependsOn: deps.filter((d) => known.has(d) && d !== key), notes: typeof s.notes === 'string' ? s.notes : null });
  }
  let foundation = null;
  if (raw.foundation && typeof raw.foundation === 'object') {
    const f = raw.foundation;
    foundation = { goal: String(f.goal ?? '').trim(), acceptance: strings(f.acceptance), owns: strings(f.owns), reason: typeof f.reason === 'string' ? f.reason : null };
    if (!foundation.goal) errors.push('foundation.goal is required (or set foundation to null)');
    if (!foundation.owns.length) errors.push('foundation.owns needs at least one glob (or set foundation to null)');
    if (foundation.owns.some((g) => g === '**' || g === '*' || g.startsWith('/') || g.includes('..'))) errors.push('foundation.owns must be relative globs inside the repo, not the whole repo');
  }
  const ids = new Set();
  const journeys = [];
  for (const j of arr(raw.journeys)) {
    const id = String(j.id ?? '');
    if (!ID.test(id)) errors.push(`journeys: id "${id}" must be [a-z0-9-]`);
    else if (ids.has(id)) errors.push(`journeys: id "${id}" is used twice`);
    ids.add(id);
    const jKeys = strings(j.stories).map((k) => k.toUpperCase());
    for (const k of jKeys) if (!known.has(k)) errors.push(`journeys.${id}: "${k}" is not a story of this epic`);
    journeys.push({ id, title: String(j.title ?? id), stories: jKeys.filter((k) => known.has(k)), steps: strings(j.steps), expected: typeof j.expected === 'string' ? j.expected : null });
  }
  const buildOrder = strings(raw.buildOrder)
    .map((k) => k.toUpperCase())
    .filter((k) => known.has(k));
  const note = {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    contracts: arr(raw.contracts),
    migrations: arr(raw.migrations),
    components: arr(raw.components),
    events: arr(raw.events),
    foundation,
    stories: [...stories.values()],
    buildOrder: [...new Set(buildOrder)],
    journeys,
    risks: strings(raw.risks),
  };
  const cycle = dependencyCycle(note.stories.map((s) => ({ key: s.key, deps: s.dependsOn })));
  if (cycle) errors.push(`stories.dependsOn has a cycle: ${cycle.join(' -> ')}`);
  // Bug epics: grouping problems are kept apart, so a note whose only problem is its grouping can fall
  // back to one PR per ticket instead of failing the epic.
  let groupErrors = [];
  if (groups) {
    const g = validateGroups(raw.prGroups, { stories: tickets ?? keys.map((key) => ({ key, blockedBy: [] })), maxPerGroup, note });
    note.prGroups = g.groups;
    groupErrors = g.errors;
  }
  const all = [...errors, ...groupErrors];
  return { ok: !all.length, errors: all, noteErrors: errors, groupErrors, note };
}

function dependencyCycle(nodes) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const mark = new Map();
  let found = null;
  const visit = (n, trail) => {
    if (found || mark.get(n.key) === 'done') return;
    if (mark.get(n.key) === 'visiting') {
      found = [...trail.slice(trail.indexOf(n.key)), n.key];
      return;
    }
    mark.set(n.key, 'visiting');
    for (const d of n.deps) if (byKey.has(d)) visit(byKey.get(d), [...trail, n.key]);
    mark.set(n.key, 'done');
  };
  for (const n of nodes) visit(n, []);
  return found;
}

const row = (cells) => `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
const table = (head, rows) => (rows.length ? [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n') : '_None._');
const list = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');

// The design note as Markdown: what the story orchestrators read and what is logged next to the JSON.
export function noteMarkdown(note, { epic }) {
  const out = [`# Epic design note: ${epic.title ?? epic.key}`, '', note.summary || '_No summary._', ''];
  out.push('## Foundation', '');
  if (note.foundation) {
    out.push(note.foundation.goal, '', `- Owns: ${note.foundation.owns.map((g) => `\`${g}\``).join(', ')}`);
    for (const a of note.foundation.acceptance) out.push(`- Done when: ${a}`);
    if (note.foundation.reason) out.push(`- Why first: ${note.foundation.reason}`);
    out.push('');
  } else out.push('_None: the stories start from the epic base._', '');
  out.push('## Shared contracts', '', table(['Name', 'Kind', 'Definition', 'Owner', 'Used by'], note.contracts.map((c) => [c.name, c.kind, c.definition, c.owner, list(c.usedBy)])), '');
  out.push('## Migrations', '', table(['Name', 'Service', 'Owner'], note.migrations.map((m) => [m.name, m.service, m.owner])), '');
  out.push('## Components', '', table(['Name', 'Path', 'Owner', 'Used by'], note.components.map((c) => [c.name, c.path, c.owner, list(c.usedBy)])), '');
  out.push('## Integration events', '', table(['Event', 'Publisher', 'Subscribers'], note.events.map((e) => [e.name, e.publisher, list(e.subscribers)])), '');
  out.push('## Stories', '', table(['Story', 'Owns', 'After', 'Notes'], note.stories.map((s) => [s.key, s.owns.map((g) => `\`${g}\``).join(', '), s.dependsOn.join(', '), s.notes])), '');
  if (note.buildOrder.length) out.push(`Build order: ${note.buildOrder.join(' → ')}`, '');
  out.push('## Cross-story journeys', '');
  if (!note.journeys.length) out.push('_None._', '');
  for (const j of note.journeys) {
    out.push(`### ${j.id}: ${j.title} (${j.stories.join(', ')})`, '');
    j.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    if (j.expected) out.push('', `Expected: ${j.expected}`);
    out.push('');
  }
  if (note.risks.length) out.push('## Risks', '', ...note.risks.map((r) => `- ${r}`), '');
  return out.join('\n');
}

// The decision log record of an epic plan attempt (stage implement-epic-plan).
export function epicPlanDecision({ epic, attempt, accepted, errors = [], note = null, agent = {}, decisionId = null }) {
  return {
    stage: EPIC_PLAN_STAGE,
    story: epic.key,
    round: attempt,
    agent: 'implementer',
    agentVer: agent.version ?? null,
    subject: 'implementer',
    decision: accepted ? 'plan-written' : 'plan-rejected',
    reason: accepted ? note?.summary ?? null : errors[0] ?? null,
    decision_id: decisionId,
    rejection_reasons: accepted ? [] : errors,
    orchestrator: { cli: agent.cli ?? null, model: agent.model ?? null },
    foundation: note?.foundation ? { goal: note.foundation.goal, owns: note.foundation.owns } : null,
    journeys: (note?.journeys ?? []).map((j) => ({ id: j.id, stories: j.stories })),
    items: (note?.stories ?? []).map((s) => ({ id: s.key, owns: s.owns, dependsOn: s.dependsOn, reason: s.notes })),
  };
}

// ---------------------------------------------------------------------------------------------
// Scheduling stories inside an epic
// ---------------------------------------------------------------------------------------------

// Each story's in-epic dependencies: its Blocked-by stories plus the note's dependsOn, without cycles
// (a note dependency that would close a cycle is dropped).
export function epicDeps(stories, note = null) {
  const keys = new Set(stories.map((s) => s.key));
  const deps = new Map(stories.map((s) => [s.key, new Set((s.blockedBy ?? []).filter((k) => keys.has(k) && k !== s.key))]));
  for (const ns of note?.stories ?? []) {
    if (!deps.has(ns.key)) continue;
    for (const d of ns.dependsOn ?? []) {
      if (!keys.has(d) || d === ns.key) continue;
      deps.get(ns.key).add(d);
      if (dependencyCycle([...deps].map(([key, set]) => ({ key, deps: [...set] })))) deps.get(ns.key).delete(d);
    }
  }
  return new Map([...deps].map(([k, set]) => [k, [...set]]));
}

// Whether two stories' planned files can overlap (their `owns` in the design note). Stories without
// owns never conflict on this check.
export function ownsConflict(a = [], b = []) {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

// The stories that may start now: pending, every dependency merged, not blocked by a failed or skipped
// one (those come back in `skip`), and no `owns` overlap with a running story or one picked earlier in
// this call. `running` holds the keys running now; `merged` the keys merged into the epic branch.
export function nextStories({ order, deps, owns = new Map(), pending, running, merged, failed, slots }) {
  const start = [];
  const skip = [];
  const busy = [...running];
  for (const key of order) {
    if (!pending.has(key)) continue;
    const bad = (deps.get(key) ?? []).find((d) => failed.has(d));
    if (bad) {
      skip.push({ key, blocker: bad });
      continue;
    }
    if (start.length + running.size >= slots) continue;
    if (!(deps.get(key) ?? []).every((d) => merged.has(d))) continue;
    if (busy.some((other) => ownsConflict(owns.get(key), owns.get(other)))) continue;
    start.push(key);
    busy.push(key);
  }
  return { start, skip };
}

// ---------------------------------------------------------------------------------------------
// Epic-level QE ticket and the epic PR
// ---------------------------------------------------------------------------------------------

// The ticket the epic-level QE plans and automates: the epic's cross-story journeys as acceptance
// criteria, so the QE stage (and the PR check) handle it like a story.
export function journeyTicket({ key, epic, note, stories }) {
  const lines = [`# ${key}: ${epic.title ?? epic.key} (cross-story journeys)`, '', `**Part of:** ${epic.key}`, '', `End-to-end journeys across the stories of epic ${epic.key} (${stories.map((s) => s.key).join(', ')}), delivered together on one branch. Each story has its own verified test plan; this plan covers only what crosses stories.`, ''];
  if (note.summary) lines.push('**Summary:**', '', note.summary, '');
  lines.push('**User Story:**', '', `As a shopper, I want the features of ${epic.title ?? epic.key} to work together end to end.`, '', '**Acceptance Criteria:**', '');
  const journeys = note.journeys.length ? note.journeys : [{ id: 'whole-epic', title: 'Every story works on top of the others', stories: stories.map((s) => s.key), steps: [], expected: 'each story behaves as its acceptance criteria say with all the other stories of the epic present' }];
  for (const j of journeys) {
    lines.push(`- **${j.title}** (${j.stories.join(', ')})${j.steps.length ? `: ${j.steps.join(' → ')}` : ''}${j.expected ? `. Then ${j.expected}` : ''}`);
  }
  lines.push('', '**Stories:**', '', ...stories.map((s) => `- ${s.key}: ${s.title}`), '');
  return lines.join('\n');
}

// The body of the epic PR: every story and bug with `Closes #N`, the epic issue, and per-story evidence.
export function epicPrBody({ epic, branch, stories, results, qe = null, prChecks = {}, foundation = null, noteFile = null, group = null, followUps = [] }) {
  const lines = group
    ? [`Fixes ${group.tickets.join(', ')} of epic ${epic.key}${epic.number ? ` (#${epic.number})` : ''} as one PR group, \`${group.id}\`: ${group.title} (branch \`${branch}\`), generated by \`pipeline implement\`.`, '', ...(group.reason ? [`Grouped because: ${group.reason}${group.risk ? ` (risk: ${group.risk})` : ''}`, ''] : [])]
    : [`Delivers epic ${epic.key}${epic.number ? ` (#${epic.number})` : ''}: ${epic.title ?? ''} on one branch (\`${branch}\`), generated by \`pipeline implement\` with epic delivery.`, ''];
  if (epic.url) lines.push(`Epic: ${epic.url}`, '');
  lines.push('## Stories', '', row(['Story', 'Outcome', 'Orchestration', 'Review rounds blocked', 'QE bug-fix cycles', 'PR check']), row(['---', '---', '---', '---', '---', '---']));
  for (const s of stories) {
    const r = results[s.key] ?? {};
    const pc = prChecks[s.key];
    lines.push(row([`${s.key}${s.number ? ` (#${s.number})` : ''}: ${s.title}`, r.outcome ?? '-', r.mode ? `${r.mode}, ${r.agentRuns ?? 0} agent runs` : '-', r.reviewBlocks ?? 0, r.bugFixCycles ?? 0, pc ? `${pc.verdict ?? '?'} ${pc.score ?? '?'}/10` : '-']));
  }
  lines.push('');
  if (foundation) lines.push(`Epic foundation: ${foundation.status}${foundation.goal ? ` (${foundation.goal})` : ''}.`, '');
  if (qe) lines.push(`Cross-story journeys: test plan and automated tests ${qe.status === 'verified' ? 'verified' : qe.status} (\`${qe.key}\`)${prChecks[qe.key] ? `; PR check ${prChecks[qe.key].verdict} ${prChecks[qe.key].score}/10` : ''}.`, '');
  if (followUps.length) lines.push('## Follow-ups (not in this PR)', '', ...followUps.map((u) => `- ${u.ticket ? `${u.ticket}: ` : ''}${u.title}${u.reason ? ` (${u.reason})` : ''}`), '');
  if (noteFile) lines.push(`The epic design note is in \`${noteFile}\` on the runner.`, '');
  lines.push('Each story passed the architecture review and has a verified test plan and automated tests. The demo video of the changed e2e specs is added below by the PR demo video workflow once it has recorded them.', '');
  const closes = stories.filter((s) => s.number).map((s) => `Closes #${s.number}`);
  if (closes.length) lines.push(...closes, '');
  if (epic.number) lines.push(`Part of #${epic.number}`);
  return lines.join('\n').trimEnd() + '\n';
}
