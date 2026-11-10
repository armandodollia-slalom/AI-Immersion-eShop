// Crash recovery shared by the stages. A run records its pid and boot in its state section (or file)
// while it works; once that process is gone but the record still says it is working, the run died
// (crash, kill, reboot). Stages resume such runs a few times, with growing delays, then escalate.
import { isProcessAlive, lockHolder } from './util.mjs';

// Fields that clear a run's recovery bookkeeping once it finishes.
export const RECOVERY_DONE = { progress: null, recoveries: 0, retryAt: null };

// Whether a run recorded as one of `active` statuses has lost its process. The lock, held for the
// whole run, wins over the recorded pid. A run that has not recorded a pid yet (just spawned) gets
// recovery.startingGraceSec from `requestedAt` to do so.
export function runDied(config, run, { active, lock = null }) {
  if (!run || !active.includes(run.status)) return false;
  if (lock && lockHolder(lock)) return false;
  if (!run.pid || run.status === 'starting') return Date.now() - (run.requestedAt ? Date.parse(run.requestedAt) : 0) > config.recovery.startingGraceSec * 1000;
  return !isProcessAlive(run.pid, run.boot);
}

// What to do with a run that died: `resumed` (with the fields to save before restarting it),
// `waiting` (its backoff has not passed) or `crashed` (out of attempts: escalate). `force` starts
// the count over and skips the wait. `backoff: false` for runs that restart only when an agent stops.
export function nextAttempt(config, run, { force = false, backoff = true } = {}) {
  const { maxAttempts, backoffSec } = config.recovery;
  const attempts = force ? 0 : run.recoveries ?? 0;
  if (backoff && !force && run.retryAt && Date.now() < Date.parse(run.retryAt)) return { action: 'waiting', retryAt: run.retryAt };
  if (attempts >= maxAttempts) return { action: 'crashed', attempts };
  // A run that dies again right away waits backoffSec, then twice that, before the next attempt.
  const retryAt = backoff ? new Date(Date.now() + backoffSec * 1000 * 2 ** attempts).toISOString() : null;
  return { action: 'resumed', attempt: attempts + 1, maxAttempts, fields: { recoveries: attempts + 1, retryAt } };
}
