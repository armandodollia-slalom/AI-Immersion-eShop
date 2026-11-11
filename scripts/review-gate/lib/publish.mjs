// What runs after the pipeline publishes a fix PR (a single-ticket bug PR or a bug-epic group PR):
// assess it (triage agent + harness), record the assessment on the tickets and in the decision log.
// Nothing here changes the factory flow before the PR exists, and nothing fails a pipeline outcome.
import path from 'node:path';
import { nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { assessPr, logTriageDecision, mainCheckout, recordTicket } from './assessment.mjs';
import { prNumber } from './github.mjs';

export const stateFile = (config, pr) => path.join(config.root, config.stateDir, 'review-gate', `pr-${prNumber(pr)}.json`);
export const loadGateState = (config, pr) => readJson(stateFile(config, pr), null);
export const saveGateState = (config, pr, state) => writeJson(stateFile(config, pr), { ...state, updatedAt: nowIso() });

// deps: { gh, runAgent, log }. Returns { assessment, problems }.
export function publishGate(config, { pr, keys, cwd = config.root, base }, deps) {
  const log = deps.log ?? (() => {});
  const assessment = assessPr(config, { pr, keys, cwd, base }, deps);
  const problems = [];
  for (const t of assessment.tickets) {
    const p = recordTicket(config, deps.gh, assessment, t);
    if (p.length && !(p.length === 1 && p[0] === 'no issue')) problems.push(`${t.key}: ${p.join('; ')}`);
  }
  const main = { ...config, root: mainCheckout(cwd) };
  logTriageDecision(main, assessment);
  saveGateState(main, pr, { pr, assessment });
  log(`${pr}: severity ${assessment.severity.level ?? 'unknown'} (${assessment.severity.explanation}); ${assessment.tickets.map((t) => `${t.key} ${t.severity.level ?? '?'}, confidence ${t.confidence.score}`).join('; ')}`);
  for (const p of problems) log(`not recorded: ${p}`);
  return { assessment, problems };
}
