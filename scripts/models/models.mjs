#!/usr/bin/env node
// Model allowlist CLI. See docs/ai-pipeline/models.md.
//
//   node scripts/models/models.mjs list [--provider p] [--json] [--refresh]
//   node scripts/models/models.mjs discover [--provider p] [--refresh] [--json]
//   node scripts/models/models.mjs check [--json]
//   node scripts/models/models.mjs resolve --provider p [--model m]
import { availableModels, checkConfigs, discoverModels, loadPolicy, ModelPolicyError, resolveModel } from './lib/models.mjs';

const USAGE = `usage: node scripts/models/models.mjs <command> [options]

  list      [--provider p] [--json] [--refresh]   policy, discovery and availability per provider
  discover  [--provider p] [--json] [--refresh]   models each installed CLI can serve (cached 24h)
  check     [--json]                             fail if a configured model is not allowed
  resolve   --provider p [--model m]             print the canonical allowed id (default when no --model)`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new ModelPolicyError(`unexpected argument "${a}"`);
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) flags[k] = v;
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
    else flags[k] = true;
  }
  return { command, flags };
}

function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((cell, c) => String(cell).padEnd(widths[c])).join('  ').trimEnd()).join('\n');
}

const providersOf = (policy, flags) => {
  if (flags.provider && !policy.providers[flags.provider]) throw new ModelPolicyError(`Unknown provider "${flags.provider}". Known: ${Object.keys(policy.providers).join(', ')}.`);
  return flags.provider ? [flags.provider] : Object.keys(policy.providers);
};

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const policy = loadPolicy();
  for (const w of policy.warnings) console.error(`warning: ${w}`);

  if (command === 'list') {
    const results = [];
    for (const p of providersOf(policy, flags)) results.push(await availableModels(p, { policy, refresh: Boolean(flags.refresh) }));
    if (flags.json) return void console.log(JSON.stringify(results, null, 2));
    const rows = [['PROVIDER', 'INSTALLED', 'ALLOWED', 'DISCOVERED', 'AVAILABLE', 'DEFAULT']];
    for (const r of results) {
      const d = r.discovery;
      const discovered = !d?.installed ? '-' : d.models.length ? `${d.models.length} (${d.source}${d.cached ? ', cached' : ''})` : 'failed';
      rows.push([
        r.provider,
        d?.installed ? (d.version ?? 'yes') : 'no',
        r.allowed.join(', ') || '(none: disabled)',
        discovered,
        r.disabled ? '-' : `${r.models.join(', ') || '(none)'}${r.degraded ? ' *' : ''}`,
        r.default ?? '-',
      ]);
    }
    console.log(table(rows));
    for (const r of results) if (r.warning) console.log(`${r.degraded ? '*' : '!'} ${r.provider}: ${r.warning}`);
    return 0;
  }

  if (command === 'discover') {
    const results = [];
    for (const p of providersOf(policy, flags)) results.push(await discoverModels(p, { policy, refresh: Boolean(flags.refresh) }));
    if (flags.json) return void console.log(JSON.stringify(results, null, 2));
    for (const r of results) {
      const head = r.installed ? `${r.version ?? 'installed'}, source ${r.source ?? 'none'}${r.cached ? ', cached' : ''}` : 'not installed';
      console.log(`${r.provider} (${head})`);
      if (r.error) console.log(`  note: ${r.error}`);
      for (const m of r.models) console.log(`  ${m.id}${m.aliases.length ? `  [${m.aliases.join(', ')}]` : ''}${m.hidden ? '  (hidden)' : ''}`);
    }
    return 0;
  }

  if (command === 'check') {
    const result = checkConfigs({ policy });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const c of result.checked) console.log(`checked ${c.file} ${c.where}: ${c.model} (${c.provider})`);
      for (const p of result.problems) console.error(`NOT ALLOWED ${p.file} ${p.where}${p.model ? ` = ${p.model}` : ''}: ${p.message}`);
      console.log(result.ok ? `models: ok (${result.checked.length} configured model(s) checked)` : `models: ${result.problems.length} problem(s)`);
    }
    return result.ok ? 0 : 1;
  }

  if (command === 'resolve') {
    if (!flags.provider || flags.provider === true) throw new ModelPolicyError('resolve needs --provider');
    console.log(resolveModel(flags.provider, flags.model === true ? null : (flags.model ?? null), { policy }));
    return 0;
  }

  console.error(USAGE);
  return command ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(e instanceof ModelPolicyError ? `error: ${e.message}` : e.stack);
    process.exit(1);
  },
);
