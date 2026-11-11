// Task prompts the orchestrated implement flow gives its agents. Each agent's standing instructions are in
// .github/agents/<name>.agent.md; these add the run-specific facts and the exact result line to end with.
import path from 'node:path';
import { formatFindings } from './plan.mjs';

const fence = (text, lang = '') => `\`\`\`\`${lang}\n${String(text ?? '').replace(/\r\n/g, '\n').trimEnd()}\n\`\`\`\``;

const specBlock = (st) =>
  [
    `- id: ${st.id}`,
    `- goal: ${st.goal}`,
    `- acceptance:\n${st.acceptance.map((a) => `  - ${a}`).join('\n')}`,
    `- owns (the only paths you may change): ${st.owns.join(', ')}`,
    `- verify: ${st.verify}${st.scenario ? ` (teststack scenario: ${st.scenario})` : ''}`,
    st.dependsOn?.length ? `- builds on (already merged into the story branch): ${st.dependsOn.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

export const planSchema = `{
  "mode": "delegate" | "self",
  "modeReason": "<one short sentence: why delegate or self>",
  "splitReason": "<delegate: one short sentence on why this split>",
  "uiStory": true | false,
  "features": { "services": ["Catalog.API", "..."], "estimatedSize": "small" | "medium" | "large" },
  "notes": "<optional: how the pieces fit together>",
  "subtasks": [
    {
      "id": "api",                              // lowercase letters, digits, dashes; unique
      "goal": "<what this subtask delivers>",
      "acceptance": ["<checkable criterion>", "..."],
      "owns": ["src/Catalog.API/**"],           // path globs; no two subtasks may own the same file
      "dependsOn": [],                          // ids that must be merged first
      "modelClass": "small" | "medium" | "large",
      "modelReason": "<one short sentence>",
      "justification": "<required when modelClass is large>",
      "verify": "code" | "ui",                  // ui only for UI stories
      "verifyReason": "<one short sentence>",
      "scenario": "<optional teststack scenario a ui verifier loads>",
      "expectedFiles": 3,                       // files you expect it to change
      "expectedLoc": 120,                       // lines added plus removed you expect
      "confidence": 0.8,                        // 0-1: how sure you are this subtask passes first time
      "alternatives": [{ "option": "<rejected option>", "reason": "<one line>" }]
    }
  ]
}`;


export function planTask({ key, storyFile, worktree, uiStory, limits, errors = null }) {
  const lines = [
    `Plan story ${key}: ${path.relative(worktree, storyFile)}`,
    '',
    'You are the orchestrator, running headless under `pipeline implement`, in PLAN mode: read the story and the code (graphify first), then return a plan. Do not edit files.',
    '',
    'The harness runs each subtask as a verifier pair: a pair-implementer in its own worktree (branched from the story branch) that may change only the files its `owns` globs match, checked by a fresh verifier after every round. Approved subtasks are merged into the story branch in dependency order; you then integrate.',
    '',
    'Rules the harness enforces:',
    `- At most ${limits.maxSubtasks} subtasks. A story that needs more must be split: say so in \`notes\` with mode "delegate" and the subtask list you would need; the run fails with "split the story".`,
    `- \`mode: "self"\` when the story touches one service or about ${limits.selfModeMaxFiles} files or fewer: you implement it yourself (still checked by a verifier). Give at most one subtask entry for its goal, acceptance and verify (its \`owns\` is ignored).`,
    '- `owns` globs must not overlap between subtasks; every file belongs to exactly one subtask. Shared files (Directory.Packages.props, AppHost wiring, Identity config) go to the subtask that needs them first; others depend on it.',
    '- `dependsOn` lists ids that must be merged first; no cycles. Independent subtasks run in parallel.',
    `- modelClass: small for mechanical changes, medium for normal work, large only for genuinely hard design work (at most ${limits.maxLargeSubtasks}, with a justification).`,
    `- verify "ui" makes a verifier drive the running app and take screenshots. ${uiStory ? 'This IS a UI story: use verify "ui" for subtasks that change pages or components.' : 'This is NOT a UI story (no [FE] tag, no WebApp/WebAppComponents/Blazor in the title, no .razor file named): use verify "code" only and uiStory false.'}`,
    '- Tests are not yours (QE writes them later); do not plan test subtasks.',
    '- The reason, expectation and confidence fields are required and short. They go to the decision log (to learn which plans work), never to the verifiers. In self mode give `modeReason`, `features`, and for the one subtask entry the same reason/expectation fields.',
    '',
    'If an Open Question or a missing blocker makes the story unimplementable, end with `AGENT_RESULT: {"status": "blocked", "reason": "<one sentence>"}` instead.',
    '',
    'Otherwise end your reply with exactly one line `AGENT_RESULT: <plan JSON on one line>`, where the plan follows this shape (comments are explanations, not JSON):',
    '',
    fence(planSchema, 'jsonc'),
  ];
  if (errors?.length) lines.push('', 'Your previous plan was rejected. Fix these problems and return the whole plan again:', '', ...errors.map((e) => `- ${e}`));
  return lines.join('\n');
}

export function pairImplementerTask({ key, storyFile, st, worktree, branch, base, round, maxRounds, findings, screenshots, diagnostics, self = false }) {
  const lines = [
    `Implement subtask "${st.id}" of story ${key} (story file: ${path.relative(worktree, storyFile)}; read it for context only).`,
    '',
    `Working directory: ${worktree} on branch ${branch}, branched from the story branch at ${base.slice(0, 12)}. Round ${round} of at most ${maxRounds}.`,
    '',
    '### Subtask',
    '',
    specBlock(st),
    '',
    'Rules:',
    self
      ? '- You are the orchestrator implementing the whole story yourself (self mode); change what the story needs.'
      : `- Change only files matching owns (${st.owns.join(', ')}). The harness checks the diff after every round: any other changed file fails the round. If the subtask cannot be done inside owns, report blocked and say which file you need.`,
    '- Commit your work on this branch with messages prefixed with the story key. Anything left uncommitted is committed for you.',
    '- Never push, reset, checkout, switch, rebase or touch worktrees. Do not run `pipeline start` or `pipeline done`. Do not spawn subagents.',
    '- Do not write tests, teststack scenarios or Playwright specs; QE does that.',
    '- Run the fast checks your agent file lists (build, existing unit tests of what you touched) before you finish; the harness runs them again and a fresh verifier reviews your diff.',
  ];
  if (findings?.length) {
    lines.push('', `### Findings from round ${round - 1} (address every blocking one)`, '', formatFindings(findings));
  }
  if (screenshots?.length) lines.push('', 'Screenshots the UI verifier took (open them to see what it saw):', ...screenshots.map((s) => `- ${s}`));
  if (diagnostics) lines.push('', '### Language server diagnostics on your changed files (last round)', '', diagnostics);
  lines.push('', 'End your reply with exactly one line:', 'AGENT_RESULT: {"status": "done" | "blocked", "reason": "<one sentence>"}');
  return lines.join('\n');
}

const verdictLine = (ui) =>
  `AGENT_RESULT: {"verdict": "APPROVED" | "CHANGES_REQUESTED", "summary": "<one or two sentences>", "findings": [{"severity": "blocking" | "minor", "file": "<path>", "line": <number or null>, ${ui ? '"screenshot": "<absolute path of the screenshot that shows it>", ' : ''}"issue": "<what is wrong>", "fix": "<what to change>"}]}`;

export function codeVerifierTask({ key, st, round, maxRounds, diff, checks, diagnostics }) {
  return [
    `Verify subtask "${st.id}" of story ${key}, round ${round} of ${maxRounds}. You have a fresh context: judge only the subtask spec, the diff and the outputs below. You may read files and query graphify; you do not edit anything.`,
    '',
    '### Subtask',
    '',
    specBlock(st),
    '',
    '### Build and test output collected by the harness',
    '',
    fence(checks || '(no checks configured)'),
    '',
    '### Language server diagnostics on the changed files',
    '',
    fence(diagnostics || '(unavailable)'),
    '',
    '### Diff against the story branch',
    '',
    fence(diff, 'diff'),
    '',
    'Every blocking finding must name the file and line (from the diff) and say exactly what to change. Errors in the diagnostics block approval anyway; do not repeat them unless you add something.',
    '',
    'End your final message with exactly one line (valid JSON, no code fence):',
    verdictLine(false),
  ].join('\n');
}

export function uiVerifierTask({ key, st, round, maxRounds, diff, checks, diagnostics, webappUrl, screenshotsDir, worktree }) {
  return [
    `Verify subtask "${st.id}" of story ${key} in the running app, round ${round} of ${maxRounds}. You have a fresh context.`,
    '',
    `The app built from this subtask's worktree (${worktree}) is running at ${webappUrl}. Save every screenshot under ${screenshotsDir} (it exists; nowhere else). Do not edit source files; the harness discards any change you leave in the worktree.`,
    '',
    '### Subtask',
    '',
    specBlock(st),
    '',
    '### Build and test output collected by the harness',
    '',
    fence(checks || '(no checks configured)'),
    '',
    '### Language server diagnostics on the changed files',
    '',
    fence(diagnostics || '(unavailable)'),
    '',
    '### Diff against the story branch',
    '',
    fence(diff, 'diff'),
    '',
    'Check every acceptance criterion in the browser (see your agent file for how to drive Playwright). Each blocking finding must reference the screenshot that shows it, and the source file and line you believe is responsible when you can tell.',
    '',
    'End your final message with exactly one line (valid JSON, no code fence):',
    verdictLine(true),
  ].join('\n');
}

export function escalationTask({ key, storyFile, st, worktree, branch, outcome, findings, takeoverAllowed, otherOwns }) {
  return [
    `Escalation for story ${key} (story file: ${path.relative(worktree, storyFile)}): subtask "${st.id}" ${outcome === 'blocked' ? 'was reported blocked by its implementer' : 'was not approved within its round limit'}.`,
    '',
    `Working directory: ${worktree} on ${branch}, which holds the pair's last attempt.`,
    '',
    '### Subtask',
    '',
    specBlock(st),
    '',
    '### All findings from its rounds',
    '',
    findings.length ? formatFindings(findings) : '(none recorded)',
    '',
    `Other subtasks own: ${otherOwns.length ? otherOwns.join(', ') : '(none)'}. A rewritten subtask's owns must not overlap them.`,
    '',
    'Decide one of:',
    '- `rewrite`: the spec was wrong or too vague. Return a corrected subtask (same id) and change no files; a fresh pair implements it from the story branch. This is its only re-run.',
    takeoverAllowed
      ? '- `takeover`: implement the subtask yourself, now, in this working directory (fix the pair\'s attempt or redo it), staying inside owns (you may return a corrected `owns`), and commit. A fresh verifier then checks your work; its findings come back to you.'
      : '- `takeover` is not available (this story already used its takeover).',
    '- `fail`: the subtask cannot be done as planned (for example the story must be split or an Open Question blocks it).',
    '',
    'Never push, reset, checkout, switch, rebase or touch worktrees. End your reply with exactly one line:',
    'AGENT_RESULT: {"action": "rewrite" | "takeover" | "fail", "reason": "<one sentence>", "subtask": {<full corrected subtask, for rewrite; optional for takeover>}}',
  ].join('\n');
}

export function conflictTask({ key, worktree, branch, subtaskBranch, st, files }) {
  return [
    `Merge conflict in story ${key}: merging subtask "${st.id}" (${subtaskBranch}) into ${branch} in ${worktree} stopped with conflicts in:`,
    ...files.map((f) => `- ${f}`),
    '',
    '### The subtask',
    '',
    specBlock(st),
    '',
    'Resolve every conflict so both sides\' intent survives, `git add` the files and finish the merge with `git commit --no-edit`. Do not abort the merge, reset, checkout, switch or rebase. Run the build afterwards if you can.',
    '',
    'End your reply with exactly one line:',
    'AGENT_RESULT: {"status": "done" | "blocked", "reason": "<one sentence>"}',
  ].join('\n');
}

export function integrationTask({ key, storyFile, branch, worktree, base, plan, notes }) {
  const lines = [
    `Integrate story ${key}: ${path.relative(worktree, storyFile)}`,
    '',
    'You are the orchestrator, running headless under `pipeline implement`, in INTEGRATE mode. Your plan\'s subtasks were implemented by verifier pairs and merged into this branch:',
    '',
    ...plan.subtasks.map((s) => `- ${s.id}: ${s.goal}`),
    '',
    `The worktree (${worktree}) and branch (${branch}, based on ${base}) are your working directory. Make the pieces fit: build, run the existing unit tests of every service touched, fix anything that does not line up across subtasks, then close out the story (Implementation Notes) as your agent file says.`,
    '- Do not create worktrees, switch branches, push, or open a PR. Do not run `pipeline start` or `pipeline done`; the runner does that. Do not spawn subagents.',
    '- Commit your work with clear messages. Anything left uncommitted is committed for you.',
  ];
  if (notes?.length) lines.push('', 'Problems the harness found while merging:', '', ...notes.map((n) => `- ${n}`));
  lines.push('', 'End your reply with exactly one line:', 'AGENT_RESULT: {"status": "done" | "blocked" | "partial", "reason": "<one sentence>"}');
  return lines.join('\n');
}
