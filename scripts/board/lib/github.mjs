import { run } from '../../pipeline/lib/util.mjs';

// Thin wrappers over the gh CLI, which owns authentication (Projects need the `project` scope:
// `gh auth refresh -s project`).
export function gh(args, { input, cwd } = {}) {
  const result = run('gh', args, { input, cwd, timeoutSec: 120 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 600)}`);
  return result.stdout;
}

export const ghJson = (args, opts) => {
  const out = gh(args, opts).trim();
  return out ? JSON.parse(out) : null;
};

export function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return ghJson(args).data;
}

export const currentLogin = () => gh(['api', 'user', '--jq', '.login']).trim();
