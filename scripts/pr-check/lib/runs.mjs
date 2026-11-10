// Crash recovery for PR checks started by hand (`pr-check run`). Each run keeps
// .agent-state/pr-check/<id>/progress.json up to date: its flags, its process and, in fix mode, the
// loop state after each critique and fix. A run whose process died before it finished is restarted
// with `run --resume` by `pr-check resume` (or `pipeline resume`), a few times, then escalated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { nextAttempt, runDied } from '../../pipeline/lib/recovery.mjs';
import { escalate, lockFile, logFile } from '../../pipeline/lib/state.mjs';
import { nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pr-check.mjs');
const RUN_ONLY = new Set(['resume', 'json', 'hook']);

const checksDir = (config) => path.join(config.root, config.stateDir, 'pr-check');
export const progressFile = (config, id) => path.join(checksDir(config), id, 'progress.json');
export const readProgress = (config, id) => readJson(progressFile(config, id), null);

export function writeProgress(config, id, fields) {
  const file = progressFile(config, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, { ...readJson(file, {}), ...fields });
}

// The `run` flags that restart the same check.
export function runArgs(flags) {
  return Object.entries(flags)
    .filter(([k, v]) => !RUN_ONLY.has(k) && v !== false && v != null)
    .flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, String(v)]));
}

function interrupted(config) {
  const dir = checksDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => ({ id, progress: readProgress(config, id) }))
    .filter(({ id, progress }) => progress && !progress.finishedAt && runDied(config, { ...progress, status: 'running' }, { active: ['running'], lock: lockFile(config, id, 'pr-check') }));
}

// Restarts every interrupted manual check in the background; returns one line per check.
export function resumeRuns(config, { id = null, force = false } = {}) {
  return interrupted(config)
    .filter((r) => !id || r.id === id || r.progress.story === id)
    .map(({ id: runId, progress }) => {
      const at = progress.loop ? ` from round ${progress.loop.round}${progress.loop.phase === 'fix' ? ' (fix)' : ''}` : '';
      const next = nextAttempt(config, progress, { force });
      if (next.action === 'waiting') return `${runId}: interrupted PR check waits until ${next.retryAt} before it is resumed (--force to resume now).`;
      if (next.action === 'crashed') {
        writeProgress(config, runId, { finishedAt: nowIso(), error: `crashed ${next.attempts} times` });
        escalate(config, { key: runId }, 'pr-check', `PR check crashed ${next.attempts} times`, `Restart it with \`node scripts/pr-check/pr-check.mjs run ${runArgs(progress.flags).join(' ')}\`.`);
        return `${runId}: the PR check crashed ${next.attempts} times; escalated (see .agent-state/escalations/${runId}-pr-check.md).`;
      }
      writeProgress(config, runId, { ...next.fields, pid: null, boot: null, requestedAt: nowIso() });
      const bg = spawnBackground(config, { script: SCRIPT, key: runId, stage: 'pr-check', args: ['run', ...runArgs(progress.flags), '--resume'], file: logFile(config, runId, 'pr-check') });
      return `${runId}: resumed the interrupted PR check${at} (attempt ${next.attempt}/${next.maxAttempts}, log: ${bg.log}).`;
    });
}

// For session start: interrupted checks, without restarting them.
export function interruptedRuns(config) {
  return interrupted(config).map(({ id, progress }) => `PR check ${id} (${progress.story}) was interrupted${progress.loop ? ` at round ${progress.loop.round}` : ''}; run \`node scripts/pipeline/pipeline.mjs resume\` to continue it.`);
}
