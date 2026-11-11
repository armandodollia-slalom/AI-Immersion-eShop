// The review gate's settings: `implement.reviewGate` and `implement.autoMerge` (scripts/implement/
// config.json) with the board's (scripts/board/config.json: repo, project, field names).
import { loadConfig, repoRoot } from '../../pipeline/lib/config.mjs';
import { isActive } from '../../board/lib/board.mjs';

const OFF = new Set(['0', 'off', 'false', 'no']);

export function gateConfig(root = repoRoot()) {
  const impl = loadConfig('implement', root);
  const board = loadConfig('board', root);
  return { ...impl, board: board.board, agent: { ...impl.agent, models: { ...board.agent?.models, ...impl.agent?.models } } };
}

// Why the gate must not touch GitHub here, or null: switched off (`reviewGate.enabled`, REVIEW_GATE=0),
// PRs off (experiments), or the board is not this checkout's (forks, test repos).
export function gateOff(config, env = process.env) {
  if (config.implement?.reviewGate?.enabled === false) return 'implement.reviewGate.enabled is false';
  if (OFF.has(String(env.REVIEW_GATE ?? '').toLowerCase())) return 'REVIEW_GATE is off';
  if (env.PIPELINE_NO_PR === '1') return 'PIPELINE_NO_PR=1';
  if (!isActive(config)) return 'the board is not active for this checkout';
  return null;
}
