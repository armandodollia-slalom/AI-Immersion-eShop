// Human decisions: a human's answers to the escalation questions of a ticket that ended Failed
// (scripts/board/lib/escalation.mjs). They are recorded under `## Decisions` in the issue body; `board fetch`
// writes them next to the cached story as decisions.md, and every agent prompt of a re-run includes them as
// binding requirements. See docs/ai-pipeline/escalations.md.
import fs from 'node:fs';
import path from 'node:path';

export const HUMAN_DECISIONS_FILE = 'decisions.md';

// The decisions next to a story file (a cached ticket's story.md), or null.
export function readDecisions(storyFile) {
  if (!storyFile) return null;
  try {
    const text = fs.readFileSync(path.join(path.dirname(storyFile), HUMAN_DECISIONS_FILE), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

const ROLE = {
  implement: 'Build what they decide. Where a decision and the story differ, the decision wins; say so in your Implementation Notes. Do not reopen or second-guess a decision.',
  verify: 'Hold the work to them: code that contradicts a decision is a blocking finding (quote the decision). Do not reopen a decision or raise a finding that asks for the opposite.',
  qe: 'Test the behavior they decide: a case or test that contradicts a decision is wrong. Report implementation behavior that contradicts a decision as a product bug. Do not reopen a decision.',
};

// The prompt block for a role (implement | verify | qe): an array of lines, empty without decisions.
export function decisionsBlock(text, role = 'implement') {
  if (!text) return [];
  return ['', '### Human decisions (binding requirements)', '', `A human answered the questions of an earlier run of this ticket. These answers are requirements, like the story's acceptance criteria. ${ROLE[role] ?? ROLE.implement}`, '', `\`\`\`\`markdown\n${String(text).trim().replace(/````/g, '` ` ` `')}\n\`\`\`\``];
}
