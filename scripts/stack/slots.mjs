#!/usr/bin/env node
// Slots of the Docker Compose test stack: leases for agents, and the port/service mapping testing/teststack
// uses. See testing/README.md ("Slots"). Results go to stdout as one JSON line; messages go to stderr.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, lease, listLeases, memoryWarning, parseSlot, poolSize, release, renew, servicesFor,
  shellEnv, slotInfo, stateHome, writeSlotLoaderConfig,
} from './lib/index.mjs';

const USAGE = `Usage: node scripts/stack/slots.mjs <command> [options]

Leases (machine-wide, in $TESTSTACK_STATE_HOME or ~/.eshop-teststack; slot 0 is never leased)
  lease --owner <id> [--wait-sec N] [--pid P]   claim a free slot 1..poolSize (pid defaults to the caller's
                                                parent process; the lease goes stale when it exits)
  release --slot <n> [--owner <id>] [--force]   free a slot
  renew --slot <n> [--owner <id>] [--pid P]     refresh a lease's TTL
  list                                          every pool slot and its lease

Mapping
  info --slot <n>                               project, state paths, image tag, ports and URLs of a slot
  services-for [--plain] [--stdin] <files...>   compose services whose images the files affect
  shell-env --slot <n>                          KEY=VALUE lines for testing/teststack (writes the slot's loader config)

Pool size: scripts/stack/config.json poolSize, overridden by TESTSTACK_SLOTS.`;

const VALUE_FLAGS = new Set(['owner', 'wait-sec', 'pid', 'slot', 'root']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw usageError(`--${name} requires a value`);
      flags[name] = value;
    } else {
      flags[name] = true;
    }
  }
  return { flags, positional };
}

function usageError(message) {
  return Object.assign(new Error(message), { exitCode: 64 });
}

const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);

function intFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < 0) throw usageError(`--${name} must be a non-negative integer`);
  return value;
}

function requireSlot(flags) {
  if (flags.slot === undefined) throw usageError('--slot <n> is required');
  return parseSlot(flags.slot);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  const root = flags.root ?? REPO_ROOT;

  switch (command) {
    case 'lease': {
      if (!flags.owner || flags.owner === true) throw usageError('lease requires --owner <id>');
      const waitSec = intFlag(flags, 'wait-sec', 0);
      const pool = poolSize();
      const warning = memoryWarning();
      if (warning) process.stderr.write(`[slots] warning: ${warning}\n`);
      const claimed = await lease(flags.owner, { waitSec, pid: intFlag(flags, 'pid', process.ppid), cwd: process.cwd() });
      if (!claimed) {
        print({ ok: false, command, error: `no free slot (pool size ${pool}) after ${waitSec}s`, poolSize: pool, slots: listLeases() });
        return 2;
      }
      const { slot, project, webappUrl, identityUrl, dashboardUrl, ports, stateDir, imageTag } = claimed;
      print({ ok: true, command, slot, owner: flags.owner, project, webappUrl, identityUrl, dashboardUrl, ports, stateDir, imageTag,
        ...(claimed.recovered ? { recoveredStaleLease: claimed.recovered } : {}), ...(warning ? { warning } : {}) });
      return 0;
    }
    case 'release': {
      const slot = requireSlot(flags);
      const old = await release(slot, { owner: typeof flags.owner === 'string' ? flags.owner : undefined, force: Boolean(flags.force) });
      print({ ok: true, command, slot, released: Boolean(old), previousOwner: old?.owner ?? null });
      return 0;
    }
    case 'renew': {
      const slot = requireSlot(flags);
      const updated = await renew(slot, { owner: typeof flags.owner === 'string' ? flags.owner : undefined, pid: intFlag(flags, 'pid', undefined) });
      print({ ok: true, command, slot, lease: updated });
      return 0;
    }
    case 'list': {
      print({ ok: true, command, poolSize: poolSize(), stateHome: stateHome(), slots: listLeases() });
      return 0;
    }
    case 'info': {
      print({ ok: true, command, ...slotInfo(requireSlot(flags)) });
      return 0;
    }
    case 'services-for': {
      const files = [...positional];
      if (flags.stdin) files.push(...fs.readFileSync(0, 'utf8').split('\n'));
      const result = servicesFor(files.filter(f => f.trim()), { root });
      if (flags.plain) {
        if (result.services.length) process.stdout.write(`${result.services.join('\n')}\n`);
      } else {
        print({ ok: true, command, ...result });
      }
      return 0;
    }
    case 'shell-env': {
      const slot = requireSlot(flags);
      writeSlotLoaderConfig(slot, { root });
      process.stdout.write(`${shellEnv(slot)}\n`);
      return 0;
    }
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stderr.write(`${USAGE}\n`);
      return command ? 0 : 64;
    default:
      throw usageError(`unknown command '${command}'`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`[slots] error: ${error.message}\n`);
    if (error.exitCode === 64) process.stderr.write(`${USAGE}\n`);
    print({ ok: false, command: process.argv[2] ?? null, error: error.message });
    process.exitCode = error.exitCode ?? 1;
  });
}
