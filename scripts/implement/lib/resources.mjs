// Resource auto-sizing for `implement run --parallel auto` (the default) and `pipeline experiment run`:
// how many tickets (or bug groups) run at once, how many agents, language servers, stack slots and
// verifier pairs, from the memory this machine (and Docker) has free right now. Explicit numbers (flags,
// config, env) always win. Before each new ticket, group or pair the harness re-checks free memory and
// waits while it is below the reserve (back-pressure). See docs/ai-pipeline/implement.md#resources.
import os from 'node:os';
import { log, run, sleep } from '../../pipeline/lib/util.mjs';

const GB = 1024 ** 3;
export const DEFAULT_RESOURCES = { reserveGb: 6, worktreeGb: 3, agentGb: 0.5, roslynGb: 0.8, stackGb: 1.6, dockerOverheadGb: 1, maxParallel: null, waitPollSec: 15, maxWaitSec: 1800 };

// macOS keeps much of its "used" memory as inactive or purgeable pages it hands back on demand;
// `vm_stat` reports them. Returns the extra reclaimable bytes, or 0 elsewhere.
export function reclaimableBytes(vmStat) {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 4096);
  const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
  return (pages('Pages inactive') + pages('Pages purgeable')) * page;
}

// { totalGb, freeGb, dockerGb } now. `exec` and `platform` are injectable for tests.
export function memoryInfo({ exec = (cmd, args) => run(cmd, args, { timeoutSec: 10 }), platform = process.platform, totalmem = os.totalmem(), freemem = os.freemem() } = {}) {
  let free = freemem;
  if (platform === 'darwin') {
    const vm = exec('vm_stat', []);
    if (vm.status === 0) free = Math.min(totalmem, free + reclaimableBytes(vm.stdout));
  }
  let dockerGb = null;
  const d = exec(process.env.TESTSTACK_DOCKER || 'docker', ['info', '--format', '{{.MemTotal}}']);
  if (d.status === 0 && /^\d+$/.test(d.stdout.trim())) dockerGb = Math.round((Number(d.stdout.trim()) / GB) * 10) / 10;
  return { totalGb: Math.round((totalmem / GB) * 10) / 10, freeGb: Math.round((free / GB) * 10) / 10, dockerGb };
}

// The sizing, with a reason per value. Pure: give it memoryInfo() and the CPU count.
//   unit (a ticket or bug group in flight) = worktreeGb (its worktree, warm language server and builds)
//                                          + agentGb (the agent CLI working in it)
//   parallel            = (free - reserve) / unit, at least 1, at most the CPUs (and maxParallel)
//   maxConcurrentPairs  = 2 when each unit also has room for a second subtask worktree and its agent
//                         (roslynGb + agentGb), else 1
//   maxConcurrentAgents = 2 per unit (an implementer and a verifier), at most the CPUs
//   LSP_MAX_SERVERS     = one per unit plus what the rest of the budget holds at roslynGb each, at most
//                         one per unit and per pair
//   TESTSTACK_SLOTS     = (Docker memory - overhead - slot 0) / stackGb, at most parallel
export function autoSize(mem, { cpus = os.cpus().length, resources = {}, pairs = 2 } = {}) {
  const r = { ...DEFAULT_RESOURCES, ...resources };
  const budget = Math.max(0, mem.freeGb - r.reserveGb);
  const unit = r.worktreeGb + r.agentGb;
  let parallel = Math.max(1, Math.floor(budget / unit));
  parallel = Math.min(parallel, cpus, r.maxParallel ?? Infinity);
  const perUnit = budget / parallel;
  const maxConcurrentPairs = perUnit >= unit + r.roslynGb + r.agentGb ? pairs : 1;
  const maxConcurrentAgents = Math.max(parallel, Math.min(parallel * 2, cpus));
  const left = Math.max(0, budget - parallel * unit);
  const lspMaxServers = Math.min(parallel * (1 + maxConcurrentPairs), parallel + Math.floor(left / r.roslynGb));
  const teststackSlots = mem.dockerGb == null ? null : Math.max(0, Math.min(parallel, Math.floor((mem.dockerGb - r.dockerOverheadGb - r.stackGb) / r.stackGb)));
  const reasons = [
    `${mem.freeGb} GB free of ${mem.totalGb} GB, ${r.reserveGb} GB reserve: ${Math.round(budget * 10) / 10} GB for the run`,
    `parallel ${parallel}: ${unit} GB per ticket (worktree ${r.worktreeGb} + agent ${r.agentGb}), at most ${cpus} CPUs`,
    `maxConcurrentPairs ${maxConcurrentPairs}: ${Math.round(perUnit * 10) / 10} GB per ticket ${maxConcurrentPairs > 1 ? '>=' : '<'} ${unit + r.roslynGb + r.agentGb} GB for a second pair`,
    `maxConcurrentAgents ${maxConcurrentAgents}: two per ticket, at most the CPUs`,
    `LSP_MAX_SERVERS ${lspMaxServers}: one per ticket plus ${Math.round(left * 10) / 10} GB spare at ${r.roslynGb} GB each`,
    mem.dockerGb == null ? 'TESTSTACK_SLOTS unchanged: Docker memory unknown' : `TESTSTACK_SLOTS ${teststackSlots}: Docker ${mem.dockerGb} GB minus ${r.dockerOverheadGb} GB overhead and slot 0, ${r.stackGb} GB per stack, at most parallel`,
  ];
  return { parallel, maxConcurrentPairs, maxConcurrentAgents, lspMaxServers, teststackSlots, memory: mem, reasons };
}

// The resources of this run, shared with the workers through IMPLEMENT_RESOURCES (applyEnv reads it).
export const resourcesFromEnv = (env = process.env) => {
  try {
    return env.IMPLEMENT_RESOURCES ? JSON.parse(env.IMPLEMENT_RESOURCES) : null;
  } catch {
    return null;
  }
};

// `--parallel` as given: a number wins; "auto" (or nothing, when implement.parallel is "auto") sizes the
// run from free memory, prints why, and exports the derived limits to every process of the run.
export function parallelFor(config, flag, { dryRun = false, mem = null, cpus = os.cpus().length, print = (m) => console.log(m) } = {}) {
  const wanted = flag ?? config.implement.parallel ?? 'auto';
  if (wanted !== 'auto' && wanted !== true) return Math.max(1, Number(wanted) || 1);
  const sized = autoSize(mem ?? memoryInfo(), { cpus, resources: config.resources ?? {}, pairs: config.implement.maxConcurrentPairs ?? 2 });
  // Explicit env settings win over the derived ones.
  if (process.env.LSP_MAX_SERVERS) sized.lspMaxServers = Number(process.env.LSP_MAX_SERVERS);
  if (process.env.TESTSTACK_SLOTS) sized.teststackSlots = Number(process.env.TESTSTACK_SLOTS);
  print(`Resources (auto): ${sized.reasons.join('; ')}.`);
  if (!dryRun) {
    process.env.IMPLEMENT_RESOURCES = JSON.stringify({ parallel: sized.parallel, maxConcurrentPairs: sized.maxConcurrentPairs, maxConcurrentAgents: sized.maxConcurrentAgents, lspMaxServers: sized.lspMaxServers, teststackSlots: sized.teststackSlots, freeGb: sized.memory.freeGb, dockerGb: sized.memory.dockerGb, reserveGb: config.resources?.reserveGb ?? DEFAULT_RESOURCES.reserveGb });
    process.env.LSP_MAX_SERVERS = String(sized.lspMaxServers);
    if (sized.teststackSlots != null) process.env.TESTSTACK_SLOTS = String(sized.teststackSlots);
  }
  return sized.parallel;
}

// Applies the run's derived limits to a loaded config (explicit config values set by env still win:
// IMPLEMENT_MAX_AGENTS, IMPLEMENT_MAX_PAIRS).
export function applyResources(config, env = process.env) {
  const r = resourcesFromEnv(env);
  const s = config.implement;
  if (r) {
    if (r.maxConcurrentAgents) s.maxConcurrentAgents = r.maxConcurrentAgents;
    if (r.maxConcurrentPairs) s.maxConcurrentPairs = r.maxConcurrentPairs;
  }
  if (env.IMPLEMENT_MAX_AGENTS) s.maxConcurrentAgents = Number(env.IMPLEMENT_MAX_AGENTS);
  if (env.IMPLEMENT_MAX_PAIRS) s.maxConcurrentPairs = Number(env.IMPLEMENT_MAX_PAIRS);
  return config;
}

// Back-pressure: waits while free memory is below the reserve, before a new ticket, group or pair
// starts. Gives up waiting after maxWaitSec (and starts anyway, logged). Only active in auto mode.
export async function waitForMemory(config, label, { mem = () => memoryInfo(), wait = sleep, env = process.env } = {}) {
  const r = resourcesFromEnv(env);
  if (!r) return 0;
  const { waitPollSec, maxWaitSec } = { ...DEFAULT_RESOURCES, ...(config.resources ?? {}) };
  const reserve = r.reserveGb ?? DEFAULT_RESOURCES.reserveGb;
  let waited = 0;
  for (;;) {
    const m = mem();
    if (m.freeGb >= reserve) return waited;
    if (waited >= maxWaitSec) {
      log(`${label}: still only ${m.freeGb} GB free after ${waited}s; starting anyway`);
      return waited;
    }
    if (!waited) log(`${label}: ${m.freeGb} GB free, below the ${reserve} GB reserve; waiting`);
    await wait(waitPollSec * 1000);
    waited += waitPollSec;
  }
}
