// Agent provider outages: the agent CLI answers that its provider will not serve any more requests for a
// while (a monthly quota or a usage limit), so every agent the run starts fails the same way. That is not
// the story's fault: the implement run stops starting work, leaves the unfinished stories' cards where
// they are and exits as interrupted, so `pipeline implement resume` continues once the provider is back.
//
// The run (and its worker and QE processes, which inherit the environment) shares one marker file,
// PIPELINE_OUTAGE_FILE. Without it, outages are still detected and logged, but nothing is recorded.
import fs from 'node:fs';
import path from 'node:path';

const PATTERNS = [
  /exceeded your (?:monthly )?quota/i, // GitHub Copilot
  /usage limit reached/i, // Claude Code ("Claude AI usage limit reached")
  /you(?:'ve| have) (?:hit|reached) your (?:usage |session |weekly )?limit/i,
  /\blimit reached\b.{0,40}\bresets?\b/i, // "5-hour limit reached ∙ resets 3pm"
  /credit balance is too low/i,
];

// A long answer is the agent's own work (it may quote these words); only short answers, failed runs
// and stderr are checked. Returns the matching line, or null.
export function providerOutage({ output = '', stderr = '', status = 0 } = {}) {
  const text = `${stderr ?? ''}\n${status !== 0 || (output ?? '').length < 1000 ? output ?? '' : ''}`;
  const line = text.split('\n').find((l) => PATTERNS.some((re) => re.test(l)));
  return line ? line.trim().slice(0, 300) : null;
}

const outageFile = () => process.env.PIPELINE_OUTAGE_FILE || null;

export function recordOutage({ cli, agent, reason }) {
  const file = outageFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), cli, agent, reason }, null, 2)}\n`);
  } catch {
    // best effort: the agent's own failure still ends its story
  }
}

// The outage recorded at or after `since` (ms), or null.
export function readOutage(since = 0) {
  const file = outageFile();
  if (!file) return null;
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Date.parse(o.ts) >= since ? o : null;
  } catch {
    return null;
  }
}

export function clearOutage() {
  const file = outageFile();
  if (file) fs.rmSync(file, { force: true });
}
