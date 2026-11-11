// Human-in-the-loop decisions for tickets the pipeline moves to Failed. See docs/ai-pipeline/escalations.md.
//
//  1. `board fail` asks one cheap agent (escalation-questions, Sonnet) for 0-3 questions only a human can
//     answer, from the escalation notes, findings and log tail. Mechanical failures (crashes, timeouts,
//     agent outages) get none. If the call fails the comment still goes out, without questions.
//  2. The failure comment holds the questions as task-list checkboxes, the details collapsed, a
//     **Resolved** checkbox and a hidden marker (`<!-- pipeline-escalation:{json} -->`).
//  3. Ticking Resolved edits the comment; the board-escalation-resolve workflow runs `board resolve-check`,
//     which validates the answers and either unticks Resolved with what is missing, or swaps
//     `needs-human` for `escalation-resolved` and records the answers under `## Decisions` in the issue body.
//  4. `board sync` moves Failed cards labeled `escalation-resolved` (without `needs-human`) to Ready, and
//     the next `implement run` re-runs them with the decisions in every agent prompt.
import fs from 'node:fs';
import path from 'node:path';
import { extractResult, nowIso, tail } from '../../pipeline/lib/util.mjs';
import { gh, ghJson } from './github.mjs';

export const RESOLVED_LABEL = 'escalation-resolved';
export const resolvedLabel = (config) => config.board?.resolvedLabel ?? RESOLVED_LABEL;

const DEFAULTS = { maxQuestions: 3, timeoutSec: 300, logTailChars: 4000, noteChars: 6000, storyChars: 6000 };
export const questionSettings = (config) => ({ ...DEFAULTS, ...(config.board?.questions ?? {}) });

// Outcomes where nothing went wrong that a human must decide: the run crashed, timed out or lost its agent
// provider. They get no questions, only the Resolved box (fix the cause, then re-queue).
const MECHANICAL = new Set(['error', 'crashed', 'timed-out', 'interrupted', 'qe-crashed', 'qe-timed-out', 'qe-not-started', 'qe-interrupted', 'agent-unavailable', 'provider-unavailable', 'limit', 'time-limit', 'budget-exceeded', 'skipped']);
const MECHANICAL_REASON = /\b(outage|unavailable|rate.?limit|overloaded|ECONN\w*|ETIMEDOUT|timed out|crashed|exited \d+ without a result|killed)\b/i;

export function isMechanical(result) {
  const outcome = result?.outcome ?? null;
  if (!outcome) return true;
  if (MECHANICAL.has(outcome)) return true;
  // A failure with escalation notes or findings is about the ticket, whatever the reason text says.
  if (result.findings?.length) return false;
  return ['blocked', 'unresolved'].includes(outcome) ? false : MECHANICAL_REASON.test(result.reason ?? '');
}

// ---------------------------------------------------------------------------------------------
// Context: escalation notes, findings and log tail of a finished run
// ---------------------------------------------------------------------------------------------

// The escalation notes (`.agent-state/escalations/<KEY>-<stage>.md`, scripts/pipeline/lib/state.mjs) the run
// left in its worktree and in this checkout.
export function escalationNotes(config, key, result = {}) {
  const dirs = [...new Set([result.worktree, config.root].filter(Boolean).map((r) => path.join(r, config.stateDir ?? '.agent-state', 'escalations')))];
  const notes = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.startsWith(`${key}-`) || !name.endsWith('.md') || seen.has(name)) continue;
      seen.add(name);
      notes.push({ stage: name.slice(key.length + 1, -3), text: fs.readFileSync(path.join(dir, name), 'utf8').trim() });
    }
  }
  return notes;
}

// Removes a ticket's escalation notes (a re-run after a human resolved them starts clean).
export function clearEscalationNotes(config, key, roots = []) {
  const removed = [];
  for (const root of new Set([config.root, ...roots].filter(Boolean))) {
    const dir = path.join(root, config.stateDir ?? '.agent-state', 'escalations');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${key}-`) || !name.endsWith('.md')) continue;
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(path.join(dir, name));
    }
  }
  return removed;
}

function logTail(config, result, chars) {
  if (!result?.log) return '';
  const file = path.isAbsolute(result.log) ? result.log : path.join(config.root, result.log);
  try {
    return tail(fs.readFileSync(file, 'utf8'), chars);
  } catch {
    return '';
  }
}

const findingText = (f) => (typeof f === 'string' ? f : `${f.subtask ? `[${f.subtask}] ` : ''}${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.issue ?? f.detail ?? JSON.stringify(f)}${f.fix ? ` Fix: ${f.fix}` : ''}${f.screenshot ? ` (screenshot: \`${f.screenshot}\`)` : ''}`);

// ---------------------------------------------------------------------------------------------
// Questions step
// ---------------------------------------------------------------------------------------------

const fence = (text, lang = '') => `\`\`\`\`${lang}\n${String(text).replace(/````/g, '` ` ` `')}\n\`\`\`\``;

export function questionsTask({ key, result, notes, story, log, maxQuestions }) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const lines = [
    `Ticket ${key} stopped with outcome **${result.outcome ?? 'no result'}**${result.reason ? ` (${result.reason})` : ''}.`,
    '',
    `Write at most ${maxQuestions} questions that only a human can answer and that would let the next run succeed. Return no questions when the failure needs no human decision.`,
    '',
    '### Story',
    '',
    story ? fence(story, 'markdown') : '(not available)',
    '',
    '### Escalation notes',
    '',
    notes.length ? notes.map((n) => `#### ${n.stage}\n\n${fence(n.text, 'markdown')}`).join('\n\n') : '(none)',
    '',
    '### Findings',
    '',
    findings.length ? findings.slice(0, 20).map((f) => `- ${findingText(f)}`).join('\n') : '(none)',
    '',
    '### Log tail',
    '',
    log ? fence(log) : '(not available)',
    '',
    'End your reply with exactly one line:',
    'AGENT_RESULT: {"questions": [{"title": "<the question, one line>", "context": "<1-3 sentences: what the agents found and why it needs a human>", "options": [{"text": "<an answer, one line>", "recommended": true}, {"text": "<another answer>"}]}]}',
  ];
  return lines.join('\n');
}

// One line of model text, safe inside a task-list item or heading.
const clean = (s, max = 300) =>
  String(s ?? '')
    .replace(/<!--|-->|<\/?details[^>]*>|<\/?summary>/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>\-*\s]+/, '')
    .replace(/\[([ xX])\]/g, '($1)')
    .trim()
    .slice(0, max);

// Validates the agent's questions: 2-3 options each, exactly one recommended (the first when none or
// several are), at most `max` questions. Returns [{ id: 'Q1', title, context, options: [{ id: 'A', text, recommended }] }].
export function normalizeQuestions(raw, { max = DEFAULTS.maxQuestions } = {}) {
  const list = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const q of list) {
    if (out.length >= max) break;
    const title = clean(q?.title ?? q?.question);
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => (typeof o === 'string' ? { text: o } : o))
      .map((o) => ({ text: clean(o?.text ?? o?.label), recommended: Boolean(o?.recommended) }))
      .filter((o) => o.text && !/^other\b/i.test(o.text))
      .slice(0, 3);
    if (!title || options.length < 2) continue;
    const rec = options.findIndex((o) => o.recommended);
    options.forEach((o, i) => (o.recommended = i === (rec < 0 ? 0 : rec)));
    out.push({ id: `Q${out.length + 1}`, title, context: clean(q?.context, 600), options: options.map((o, i) => ({ id: String.fromCharCode(65 + i), ...o })) });
  }
  return out;
}

// Asks the escalation-questions agent. Never throws: { questions, mechanical, error }.
export function generateQuestions(config, key, result, { runAgent, notes = [], story = null, log = () => {} } = {}) {
  if (isMechanical(result)) return { questions: [], mechanical: true, error: null };
  const s = questionSettings(config);
  try {
    const task = questionsTask({ key, result, notes, story: story ? tail(story, s.storyChars) : null, log: logTail(config, result, s.logTailChars), maxQuestions: s.maxQuestions });
    const res = runAgent(config, { name: 'escalation-questions', task, mode: 'read', model: config.agent?.models?.escalationQuestions ?? null, timeoutSec: s.timeoutSec, usage: { stage: 'board', story: key, step: 'escalation questions' } });
    const raw = res?.ok ? extractResult(res.output ?? '') : null;
    if (!raw) return { questions: [], mechanical: false, error: res?.ok ? 'the agent returned no AGENT_RESULT' : `the agent ${res?.timedOut ? 'timed out' : `failed (exit ${res?.status})`}` };
    return { questions: normalizeQuestions(raw, { max: s.maxQuestions }), mechanical: false, error: null };
  } catch (error) {
    log(`${key}: escalation questions not generated: ${error.message}`);
    return { questions: [], mechanical: false, error: error.message.split('\n')[0] };
  }
}

// ---------------------------------------------------------------------------------------------
// The failure comment
// ---------------------------------------------------------------------------------------------

const MARKER = /<!-- pipeline-escalation:(\{.*?\}) -->/;
export const encodeEscalationMarker = (m) => `<!-- pipeline-escalation:${JSON.stringify(m).replace(/--/g, '-\\u002d')} -->`;
export function parseEscalationMarker(body) {
  const m = MARKER.exec(body ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// The run details: findings, branch and log (collapsed in the comment).
export function failureDetails(result, { host = 'this machine', maxFindings = 20 } = {}) {
  const r = result ?? {};
  const lines = [];
  const findings = Array.isArray(r.findings) ? r.findings : [];
  if (findings.length) {
    lines.push('**Findings**', '');
    for (const f of findings.slice(0, maxFindings)) lines.push(`- ${findingText(f)}`);
    if (findings.length > maxFindings) lines.push(`- ... and ${findings.length - maxFindings} more`);
    lines.push('');
  }
  const where = [r.branch ? `Branch: \`${r.branch}\`.` : '', r.log ? `Log on \`${host}\`: \`${r.log}\`.` : ''].filter(Boolean).join(' ');
  if (where) lines.push(where);
  return lines.join('\n').trim();
}

export const RESOLVED_LINE = "- [ ] **Resolved**: I've answered the questions; re-queue this ticket";

// Renders the failure comment. `questions` from normalizeQuestions; `notes` from escalationNotes.
export function renderEscalationComment(config, { key, result = {}, questions = [], notes = [], round = 1, host, mechanical = false, questionsError = null, maxNoteChars = DEFAULTS.noteChars }) {
  const blocked = config.board.blockedLabel;
  const lines = [`The pipeline stopped: **${result.outcome ?? 'no result'}**${result.reason ? ` (${result.reason})` : ''}.${round > 1 ? ` (Round ${round}; earlier answers are under **Decisions** in the issue body.)` : ''}`, ''];
  if (questions.length) lines.push(`I need ${questions.length} decision${questions.length > 1 ? 's' : ''} from you. Tick one answer per question; for **Other**, reply in a new comment that starts with \`Qn:\` (for example \`Q1: ...\`).`, '');
  else if (mechanical) lines.push('This looks like a mechanical failure (crash, timeout or agent outage): there is nothing to decide. Fix the cause if there is one, then tick **Resolved** to re-queue the ticket.', '');
  else if (questionsError) lines.push(`I could not prepare questions (${questionsError}). Read the details, fix or decide what is needed (write it in a comment), then tick **Resolved** to re-queue the ticket.`, '');
  else lines.push('No decision is needed from you. Read the details, fix what is needed, then tick **Resolved** to re-queue the ticket.', '');
  for (const q of questions) {
    lines.push(`### ${q.id}. ${q.title}`, '');
    if (q.context) lines.push(q.context, '');
    for (const o of q.options) lines.push(`- [ ] **${o.id}.** ${o.text}${o.recommended ? ' _(recommended)_' : ''}`);
    lines.push(`- [ ] **Other** (reply in a new comment that starts with \`${q.id}:\`)`, '');
  }
  const details = failureDetails(result, { host });
  const count = Array.isArray(result.findings) ? result.findings.length : 0;
  const summary = [notes.length ? `${notes.length} escalation note${notes.length > 1 ? 's' : ''}` : '', count ? `${count} finding${count > 1 ? 's' : ''}` : '', 'branch, log'].filter(Boolean).join(', ');
  lines.push(`<details><summary>Details: ${summary}</summary>`, '');
  for (const n of notes) lines.push(`#### Escalation note: ${n.stage}`, '', fence(tail(n.text, maxNoteChars), 'markdown'), '');
  if (details) lines.push(details, '');
  lines.push('</details>', '');
  lines.push(`When you tick **Resolved**, the board-escalation-resolve workflow checks the answers, swaps \`${blocked}\` for \`${resolvedLabel(config)}\` and records them under **Decisions** in the issue body; the next \`board sync\` moves the card back to ${config.board.columns.ready} and the next run gets them as binding requirements. (Adding the \`${resolvedLabel(config)}\` label by hand does the same, without recording answers.)`, '');
  lines.push(RESOLVED_LINE, '');
  lines.push(encodeEscalationMarker({ key, round, questions: questions.map((q) => ({ id: q.id, options: q.options.map((o) => o.id) })) }));
  return lines.join('\n');
}

// The round of the next failure comment: one more than the escalation comments already on the issue.
export const nextRound = (comments) => Math.max(0, ...comments.map((c) => parseEscalationMarker(c.body)?.round ?? 0)) + 1;

// ---------------------------------------------------------------------------------------------
// Reading the answers
// ---------------------------------------------------------------------------------------------

// The ticked boxes of a failure comment: { resolved, questions: { Q1: { title, options: [{ id, text, checked }] } } }.
// Lines inside <details> or code fences are ignored.
export function parseAnswers(body) {
  const out = { resolved: false, questions: {} };
  let q = null;
  let skip = false;
  let fenced = false;
  for (const line of String(body ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (/^\s*<details\b/i.test(line)) skip = true;
    if (/<\/details>/i.test(line)) {
      skip = false;
      continue;
    }
    if (skip) continue;
    const h = /^#{2,4}\s+(Q\d+)\b[.:)]?\s*(.*)$/.exec(line);
    if (h) {
      q = h[1];
      out.questions[q] = { title: h[2].trim(), options: [] };
      continue;
    }
    const r = /^\s*[-*]\s+\[([ xX])\]\s+\*\*Resolved\*\*/.exec(line);
    if (r) {
      out.resolved = r[1] !== ' ';
      q = null;
      continue;
    }
    const o = /^\s*[-*]\s+\[([ xX])\]\s+\*\*(Other|[A-Z])\.?\*\*\s*(.*)$/.exec(line);
    if (o && q) out.questions[q].options.push({ id: o[2], checked: o[1] !== ' ', text: o[3].replace(/\s*_\(recommended\)_\s*$/, '').trim() });
  }
  return out;
}

const BOTS = new Set(['github-actions', 'github-actions[bot]', 'dependabot[bot]']);
export const isBot = (login) => !login || BOTS.has(login) || /\[bot\]$/.test(login);

// `Qn: <answer>` replies by humans, the latest per question. A comment may answer several (one per line).
export function otherReplies(comments) {
  const replies = {};
  for (const c of comments) {
    if (isBot(c.author) || /<!-- pipeline-/.test(c.body ?? '')) continue;
    let q = null;
    for (const line of String(c.body ?? '').replace(/\r\n/g, '\n').split('\n')) {
      const m = /^\s*\**(Q\d+)\**\s*:\s*(.*)$/.exec(line);
      if (m) {
        q = m[1];
        replies[q] = { text: m[2].trim(), by: c.author, at: c.createdAt ?? null };
      } else if (q) replies[q].text = `${replies[q].text}\n${line}`.trim();
    }
  }
  return replies;
}

// Checks the answers of a failure comment against its marker. Returns { complete, missing: [text], answers:
// [{ id, title, choice, text, other }] }. `later`: the comments after the failure comment.
export function evaluateAnswers(marker, body, later = []) {
  const parsed = parseAnswers(body);
  const replies = otherReplies(later);
  const missing = [];
  const answers = [];
  for (const mq of marker?.questions ?? []) {
    const q = parsed.questions[mq.id];
    const ticked = (q?.options ?? []).filter((o) => o.checked);
    if (!ticked.length) {
      missing.push(`${mq.id} has no answer ticked.`);
      continue;
    }
    if (ticked.length > 1) {
      missing.push(`${mq.id} has ${ticked.length} answers ticked (${ticked.map((o) => o.id).join(', ')}); tick exactly one.`);
      continue;
    }
    const [o] = ticked;
    if (o.id === 'Other') {
      const reply = replies[mq.id];
      if (!reply?.text) {
        missing.push(`${mq.id} has "Other" ticked but no \`${mq.id}:\` reply.`);
        continue;
      }
      answers.push({ id: mq.id, title: q.title, choice: 'Other', text: reply.text, other: true });
    } else answers.push({ id: mq.id, title: q.title, choice: o.id, text: o.text, other: false });
  }
  return { complete: !missing.length, missing, answers, resolved: parsed.resolved };
}

export const untickResolved = (body) => String(body).replace(/^(\s*[-*]\s+)\[[xX]\](\s+\*\*Resolved\*\*)/m, '$1[ ]$2');

// ---------------------------------------------------------------------------------------------
// The `## Decisions` section of the issue body
// ---------------------------------------------------------------------------------------------

const D_BEGIN = '<!-- pipeline-decisions:begin -->';
const D_END = '<!-- pipeline-decisions:end -->';
const D_INTRO = "A human's answers to the pipeline's escalation questions. Later runs give them to every agent as binding requirements.";

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const answerLine = (a) => `- **${a.id}. ${oneLine(a.title)}** ${a.other ? `Other: ${oneLine(a.text)}` : `${a.choice}. ${oneLine(a.text)}`}`;

function parseRounds(inner) {
  const rounds = new Map();
  const parts = inner.split(/^### Round (\d+)\b/m);
  for (let i = 1; i < parts.length; i += 2) rounds.set(Number(parts[i]), `### Round ${parts[i]}${parts[i + 1].trimEnd()}`);
  return rounds;
}

// The decisions section's text (heading and rounds, no markers), or null when the body has none.
export function extractDecisions(body) {
  const b = String(body ?? '').replace(/\r\n/g, '\n');
  const start = b.indexOf(D_BEGIN);
  const end = b.indexOf(D_END, start);
  if (start < 0 || end < 0) return null;
  const inner = b.slice(start + D_BEGIN.length, end).trim();
  return parseRounds(inner).size ? inner : null;
}

// Adds (or replaces) round `round` of the decisions section. Idempotent: the same answers for the same
// round leave the body unchanged. Returns the new body.
export function upsertDecisions(body, { round, by, at, answers, note = null }) {
  const b = String(body ?? '').replace(/\r\n/g, '\n');
  const start = b.indexOf(D_BEGIN);
  const end = start < 0 ? -1 : b.indexOf(D_END, start);
  const rounds = start >= 0 && end >= 0 ? parseRounds(b.slice(start + D_BEGIN.length, end)) : new Map();
  const lines = answers.map(answerLine);
  if (note) lines.push(`- ${oneLine(note)}`);
  const existing = rounds.get(round);
  // Same answers: keep the recorded who/when.
  if (existing && existing.split('\n').filter((l) => l.startsWith('- ')).join('\n') === lines.join('\n')) return b;
  rounds.set(round, [`### Round ${round} (resolved by @${by ?? 'unknown'}, ${at})`, '', ...(lines.length ? lines : ['- (no questions; re-queued)'])].join('\n'));
  const section = [D_BEGIN, '## Decisions', '', D_INTRO, '', [...rounds.keys()].sort((x, y) => x - y).map((k) => rounds.get(k)).join('\n\n'), D_END].join('\n');
  if (start >= 0 && end >= 0) return `${b.slice(0, start)}${section}${b.slice(end + D_END.length)}`;
  return `${b.trimEnd()}\n\n${section}\n`;
}

// Carries the decisions section of `from` (the issue body on GitHub) over to a re-rendered body.
export function keepDecisions(body, from) {
  const b = String(from ?? '').replace(/\r\n/g, '\n');
  const start = b.indexOf(D_BEGIN);
  const end = start < 0 ? -1 : b.indexOf(D_END, start);
  if (start < 0 || end < 0 || String(body).includes(D_BEGIN)) return body;
  return `${String(body).trimEnd()}\n\n${b.slice(start, end + D_END.length)}\n`;
}

// ---------------------------------------------------------------------------------------------
// `board resolve-check`: run by the board-escalation-resolve workflow (issues only, github.token)
// ---------------------------------------------------------------------------------------------

const commentId = (c) => Number(/issuecomment-(\d+)/.exec(c.url ?? '')?.[1] ?? String(c.id ?? '').replace(/\D/g, '')) || null;

export function readIssue(config, number) {
  const i = ghJson(['issue', 'view', String(number), '-R', config.board.repo, '--json', 'number,title,body,labels,comments']);
  return {
    number: i.number ?? Number(number),
    title: i.title ?? '',
    body: i.body ?? '',
    labels: (i.labels ?? []).map((l) => l.name ?? l),
    comments: (i.comments ?? []).map((c) => ({ id: commentId(c), author: c.author?.login ?? c.author ?? null, body: c.body ?? '', createdAt: c.createdAt ?? null, url: c.url ?? null })),
  };
}

function addLabelCreating(config, number, label) {
  try {
    gh(['issue', 'edit', String(number), '-R', config.board.repo, '--add-label', label]);
  } catch {
    gh(['label', 'create', label, '-R', config.board.repo, '--color', '0e8a16', '--description', 'A human answered the escalation questions; board sync re-queues the ticket', '--force']);
    gh(['issue', 'edit', String(number), '-R', config.board.repo, '--add-label', label]);
  }
}

const replyWith = (config, number, body) => gh(['issue', 'comment', String(number), '-R', config.board.repo, '--body-file', '-'], { input: body });

const summarize = (answers) => answers.map((a) => (a.other ? `${a.id} → "${oneLine(a.text).slice(0, 80)}${oneLine(a.text).length > 80 ? '…' : ''}"` : `${a.id} → ${a.choice}`)).join(', ');

// Validates the latest failure comment of issue `number` and resolves it when complete. `actor`: who ticked
// Resolved (or added the label); `comment`: the edited comment's id (ignored unless it is the latest failure
// comment); `viaLabel`: a human added `escalation-resolved` by hand. Returns { status, ... }.
export function resolveCheck(config, number, { actor = null, comment = null, viaLabel = false, now = nowIso() } = {}) {
  const issue = readIssue(config, number);
  const idx = issue.comments.findLastIndex((c) => parseEscalationMarker(c.body));
  if (idx < 0) {
    // An older failure comment without questions: the label alone re-queues it.
    if (!viaLabel) return { status: 'no-escalation' };
    if (issue.labels.includes(config.board.blockedLabel)) gh(['issue', 'edit', String(issue.number), '-R', config.board.repo, '--remove-label', config.board.blockedLabel]);
    return { status: 'resolved', round: null, answers: [], missing: [] };
  }
  const c = issue.comments[idx];
  if (comment && c.id && Number(comment) !== c.id) return { status: 'not-latest' };
  const marker = parseEscalationMarker(c.body);
  const blocked = config.board.blockedLabel;
  const resolved = resolvedLabel(config);
  const evaluation = evaluateAnswers(marker, c.body, issue.comments.slice(idx + 1));
  if (!viaLabel && !evaluation.resolved) return { status: 'not-ticked' };
  if (issue.labels.includes(resolved) && !issue.labels.includes(blocked) && !viaLabel) return { status: 'already-resolved' };
  if (!evaluation.complete && !viaLabel) {
    if (c.id) gh(['api', '-X', 'PATCH', `repos/${config.board.repo}/issues/comments/${c.id}`, '--input', '-'], { input: JSON.stringify({ body: untickResolved(c.body) }) });
    replyWith(config, issue.number, [`⚠️ Not resolved yet${actor && !isBot(actor) ? `, @${actor}` : ''}:`, '', ...evaluation.missing.map((m) => `- ${m}`), '', 'I unticked **Resolved**. Answer the questions above, then tick it again.'].join('\n'));
    return { status: 'incomplete', missing: evaluation.missing };
  }
  const round = marker.round ?? 1;
  const by = actor && !isBot(actor) ? actor : 'unknown';
  const note = viaLabel && !evaluation.complete ? `Marked resolved with the \`${resolved}\` label; unanswered: ${evaluation.missing.join(' ')}` : null;
  const body = upsertDecisions(issue.body, { round, by, at: now, answers: evaluation.answers, note });
  if (body !== issue.body.replace(/\r\n/g, '\n')) gh(['issue', 'edit', String(issue.number), '-R', config.board.repo, '--body-file', '-'], { input: body });
  if (issue.labels.includes(blocked)) gh(['issue', 'edit', String(issue.number), '-R', config.board.repo, '--remove-label', blocked]);
  if (!issue.labels.includes(resolved)) addLabelCreating(config, issue.number, resolved);
  const decided = evaluation.answers.length ? ` Decisions recorded: ${summarize(evaluation.answers)}.` : '';
  replyWith(config, issue.number, `✅ Resolved by @${by}.${decided} The ticket goes back to ${config.board.columns.ready} at the next \`board sync\` and re-runs with these answers.`);
  return { status: 'resolved', round, answers: evaluation.answers, missing: evaluation.missing };
}

// The whole failure comment for `board fail`: notes, questions (or none), round. Never throws for the
// questions step; `comments` are the issue's comments (for the round).
export function failureComment(config, key, result, { runAgent, comments = [], story = null, host = 'this machine', log = () => {} } = {}) {
  const notes = escalationNotes(config, key, result ?? {});
  const q = generateQuestions(config, key, result ?? {}, { runAgent, notes, story, log });
  return renderEscalationComment(config, { key, result: result ?? {}, questions: q.questions, notes, round: nextRound(comments), host, mechanical: q.mechanical, questionsError: q.error });
}
