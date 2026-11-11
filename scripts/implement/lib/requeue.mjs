// `pipeline implement requeue`: picks up the Failed tickets a human resolved on GitHub (labeled
// escalation-resolved, no needs-human; see docs/ai-pipeline/escalations.md) and runs them in one batch,
// and the bug fixes a person reopened after the review gate assessed them (`reopened`, listed by
// `board sync`; see docs/ai-pipeline/review-gate.md), each with --force so its earlier run is redone.
// Safe on a timer (scripts/implement/requeue-schedule.mjs): it does nothing when nothing is resolved,
// when another implement batch is active or was interrupted on this machine, or during an agent provider
// outage. Re-queueing goes through `board sync` (Failed -> Ready), so GitHub Actions never need a project token.
import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive, lockHolder, acquireLock, releaseLock, nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { batchFile, runsDir } from './implement.mjs';

export const requeueLockFile = (config) => path.join(runsDir(config), 'requeue.lock');
export const lastRequeueFile = (config) => path.join(runsDir(config), 'requeue-last.json');
// The agent provider outage marker of an implement run (D12, scripts/pipeline/lib/outage.mjs).
export const outageFile = (config) => path.join(runsDir(config), 'agent-outage.json');

const DEFAULTS = { outageCooldownMin: 60 };
const settings = (config) => ({ ...DEFAULTS, ...(config.implement?.requeue ?? {}) });

// Why a requeue must not start a batch now, or null.
export function blockedReason(config, { now = Date.now() } = {}) {
  const holder = lockHolder(requeueLockFile(config));
  if (holder && holder !== process.pid) return `another requeue is running (pid ${holder})`;
  const batch = readJson(batchFile(config), null);
  if (batch && !batch.finishedAt) {
    if (isProcessAlive(batch.pid, batch.boot)) return `an implement run is active (pid ${batch.pid}, started ${batch.startedAt})`;
    return 'the last implement run was interrupted; continue it with `pipeline implement resume` first';
  }
  const outage = readJson(outageFile(config), null);
  const at = Date.parse(outage?.at ?? '');
  if (outage && (!at || now - at < settings(config).outageCooldownMin * 60_000)) return `the agent provider is unavailable (${outage.cli ?? 'agent'}: ${outage.reason ?? 'outage'}, since ${outage.at ?? '?'})`;
  return null;
}

// The last JSON line of a command's output.
function jsonLine(stdout) {
  for (const line of String(stdout ?? '').trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') return v;
    } catch {
      // not JSON
    }
  }
  return null;
}

// Splits the resolved keys into implement runs: tickets of an epic whose epic run is still in progress go
// together per delivery unit (they join the unit's branch and PR group), every other ticket goes in one
// run. `ticketOf(key)` -> { key, epic }; `epicRunOf(epicKey)` -> the epic run state or null.
export function batchesFor(keys, { ticketOf, epicRunOf }) {
  const loose = [];
  const units = new Map();
  for (const key of keys) {
    const epic = ticketOf(key)?.epic ?? null;
    const state = epic ? epicRunOf(epic) : null;
    const unit = state && !['done', 'failed', 'blocked'].includes(state.status) ? Object.values(state.units ?? {}).find((u) => u.keys?.includes(key)) : null;
    if (!unit) {
      loose.push(key);
      continue;
    }
    const id = `${epic}/${unit.id ?? unit.branch}`;
    if (!units.has(id)) units.set(id, { epic, unit: unit.id ?? null, keys: [] });
    units.get(id).keys.push(key);
  }
  return [...(loose.length ? [{ epic: null, unit: null, keys: loose }] : []), ...units.values()];
}

// Runs one requeue pass. deps: { board(args) -> { status, stdout }, runImplement(args) -> exit code,
// ticketOf, epicRunOf, log }. Returns { status, keys, batches, exit }.
export async function requeue(config, { requeueOnly = false, dryRun = false, parallel = 'auto', pr = true, base = null } = {}, deps) {
  const log = deps.log ?? (() => {});
  const finish = (r) => {
    if (!dryRun) writeJson(lastRequeueFile(config), { at: nowIso(), ...r });
    return r;
  };
  const blocked = dryRun || requeueOnly ? null : blockedReason(config);
  if (blocked) {
    log(`Requeue skipped: ${blocked}.`);
    return finish({ status: 'skipped', reason: blocked, keys: [], batches: [], exit: 0 });
  }
  const lock = requeueLockFile(config);
  if (!dryRun && !acquireLock(lock)) {
    log('Requeue skipped: another requeue is running.');
    return { status: 'skipped', reason: 'another requeue is running', keys: [], batches: [], exit: 0 };
  }
  try {
    // A dry run only lists; otherwise sync moves the resolved Failed cards to Ready.
    const r = deps.board(dryRun ? ['resolved', '--json'] : ['sync', '--json']);
    const listed = r.status === 0 ? jsonLine(r.stdout) : null;
    if (r.status !== 0) log(`board ${dryRun ? 'resolved' : 'sync'} failed: ${String(r.stderr ?? r.stdout).trim().split('\n').at(-1)}`);
    const resolvedKeys = [...new Set(listed?.resolved ?? [])];
    const reopenedKeys = [...new Set(listed?.reopened ?? [])].filter((k) => !resolvedKeys.includes(k));
    const keys = [...resolvedKeys, ...reopenedKeys];
    if (listed?.requeued?.length) log(`Moved to Ready: ${listed.requeued.join(', ')}.`);
    if (!keys.length) {
      log('Nothing to requeue: no ticket is labeled escalation-resolved without needs-human, and no bug fix was reopened.');
      return finish({ status: 'nothing', keys: [], batches: [], exit: 0 });
    }
    const batches = [...batchesFor(resolvedKeys, deps), ...batchesFor(reopenedKeys, deps).map((b) => ({ ...b, reopened: true }))];
    const args = (b) => ['run', ...b.keys, '--parallel', String(parallel), ...(pr ? ['--pr'] : []), ...(base ? ['--base', base] : []), ...(b.reopened ? ['--force'] : [])];
    if (resolvedKeys.length) log(`Resolved by a human: ${resolvedKeys.join(', ')}.`);
    if (reopenedKeys.length) log(`Reopened by a human after the review gate: ${reopenedKeys.join(', ')}.`);
    for (const b of batches) log(`${dryRun || requeueOnly ? 'Would run' : 'Running'}: implement ${args(b).join(' ')}${b.epic ? `  (joins ${b.epic}${b.unit ? `, group ${b.unit}` : ''})` : ''}`);
    if (dryRun) return { status: 'dry-run', keys, batches, exit: 0 };
    if (requeueOnly) return finish({ status: 'requeued', keys, batches, exit: 0 });
    let exit = 0;
    for (const b of batches) {
      const code = await deps.runImplement(args(b));
      log(`implement ${args(b).slice(0, 1 + b.keys.length).join(' ')} exited ${code}.`);
      // 75: the run stopped on an agent provider outage (D12); start nothing more.
      if (code === 75) {
        exit = 75;
        break;
      }
      if (code !== 0) exit = exit || code;
    }
    return finish({ status: 'ran', keys, batches, exit });
  } finally {
    if (!dryRun) releaseLock(lock);
  }
}

// The newest requeue log and the last pass, for `requeue-schedule status`.
export function lastRequeue(config) {
  const dir = path.join(config.root, config.stateDir, 'logs');
  const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^requeue-.*\.log$/.test(f)).sort() : [];
  return { last: readJson(lastRequeueFile(config), null), log: logs.length ? path.join(dir, logs.at(-1)) : null };
}
