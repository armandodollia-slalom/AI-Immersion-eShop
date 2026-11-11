#!/usr/bin/env node
// Runs `pipeline implement requeue` on a timer from this machine (macOS launchd user agent), so tickets a
// human resolved on GitHub are picked up together without anyone starting a run. See
// docs/ai-pipeline/escalations.md#requeue-on-a-timer (Windows: Task Scheduler, documented there).
//
//   node scripts/implement/requeue-schedule.mjs install [--interval <minutes>] [--dry-run]
//   node scripts/implement/requeue-schedule.mjs uninstall
//   node scripts/implement/requeue-schedule.mjs status
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runMain } from '../pipeline/lib/cli.mjs';
import { INSTALL_ROOT, loadConfig } from '../pipeline/lib/config.mjs';
import { run } from '../pipeline/lib/util.mjs';
import { lastRequeue } from './lib/requeue.mjs';

export const LABEL = 'com.eshop.pipeline.requeue';
// Environment the agent CLIs and the pipeline need; everything else (secrets included) stays out of the
// plist: the agent CLIs use their own sign-in.
const ENV_KEYS = ['PATH', 'HOME', 'PIPELINE_AGENT_CLI', 'PIPELINE_AGENT_CMD', 'PIPELINE_BOARD', 'DOTNET_ROOT', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'LANG'];

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The main checkout (not a worktree): the parent of the git common dir.
export function mainCheckout(root = INSTALL_ROOT) {
  const r = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
  const common = r.status === 0 ? r.stdout.trim() : path.join(root, '.git');
  return path.basename(common) === '.git' ? path.dirname(common) : root;
}

export function renderPlist({ label = LABEL, node = process.execPath, checkout, intervalMin = 60, env = {}, logFile }) {
  const envXml = Object.entries(env)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(path.join(checkout, 'scripts/pipeline/pipeline.mjs'))}</string>
      <string>implement</string>
      <string>requeue</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(checkout)}</string>
    <key>StartInterval</key>
    <integer>${Math.max(5, Math.round(intervalMin)) * 60}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logFile)}</string>
  </dict>
</plist>
`;
}

const plistPath = (label = LABEL) => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest, new Set(['interval']));
  const checkout = mainCheckout();
  const file = plistPath();
  if (!['install', 'uninstall', 'status'].includes(command)) {
    console.log('Usage: node scripts/implement/requeue-schedule.mjs install [--interval <minutes>] [--dry-run] | uninstall | status');
    return command ? 2 : 0;
  }
  if (command !== 'status' && process.platform !== 'darwin' && !flags['dry-run']) {
    console.error('install/uninstall use launchd (macOS). On Windows, use Task Scheduler as described in docs/ai-pipeline/escalations.md#requeue-on-a-timer.');
    return 2;
  }
  if (command === 'install') {
    const intervalMin = Number(flags.interval ?? 60);
    if (!Number.isFinite(intervalMin) || intervalMin < 5) {
      console.error('--interval is in minutes, at least 5.');
      return 2;
    }
    const config = loadConfig('implement', checkout);
    const logFile = path.join(checkout, config.stateDir, 'logs', 'requeue-launchd.log');
    const plist = renderPlist({ checkout, intervalMin, env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])), logFile });
    if (flags['dry-run']) {
      console.log(`Would write ${file}:\n\n${plist}`);
      return 0;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    run('launchctl', ['bootout', domain(), file]);
    fs.writeFileSync(file, plist);
    const r = run('launchctl', ['bootstrap', domain(), file]);
    if (r.status !== 0) {
      console.error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
      return 1;
    }
    console.log(`Installed ${LABEL}: \`pipeline implement requeue\` every ${intervalMin} min from ${checkout} (log: ${path.relative(checkout, logFile)}).`);
    return 0;
  }
  if (command === 'uninstall') {
    if (!fs.existsSync(file)) {
      console.log(`${LABEL} is not installed.`);
      return 0;
    }
    run('launchctl', ['bootout', domain(), file]);
    fs.rmSync(file, { force: true });
    console.log(`Uninstalled ${LABEL}.`);
    return 0;
  }
  // status
  const installed = fs.existsSync(file);
  const loaded = installed && process.platform === 'darwin' ? run('launchctl', ['print', `${domain()}/${LABEL}`]).status === 0 : false;
  const interval = installed ? /<key>StartInterval<\/key>\s*<integer>(\d+)</.exec(fs.readFileSync(file, 'utf8'))?.[1] : null;
  console.log(installed ? `${LABEL}: installed${loaded ? ' and loaded' : ' (not loaded)'}, every ${Number(interval) / 60} min (${file}).` : `${LABEL}: not installed (install with \`node scripts/implement/requeue-schedule.mjs install\`).`);
  const { last, log } = lastRequeue(loadConfig('implement', checkout));
  console.log(last ? `Last requeue: ${last.at}: ${last.status}${last.keys?.length ? ` (${last.keys.join(', ')})` : ''}${last.reason ? `: ${last.reason}` : ''}${last.exit ? `, exit ${last.exit}` : ''}.` : 'Last requeue: never.');
  if (log) console.log(`Latest log: ${log}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMain(main, 'requeue-schedule');
