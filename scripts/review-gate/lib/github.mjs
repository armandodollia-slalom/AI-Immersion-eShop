// GitHub calls of the review gate, through an injectable `gh` runner (args, { input, env }) ->
// { status, stdout, stderr }, so tests use an in-memory GitHub. The real runner is the gh CLI, which
// owns authentication. All merging goes through mergePr (one function, one identity setting).
import { run } from '../../pipeline/lib/util.mjs';

export const realGh = (args, { input, env } = {}) => run('gh', args, { input, env, timeoutSec: 120 });

export function ghOk(gh, args, opts) {
  const r = gh(args, opts);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${String(r.stderr ?? '').trim().slice(0, 400)}`);
  return r.stdout;
}

export function ghJson(gh, args, opts) {
  const out = ghOk(gh, args, opts).trim();
  return out ? JSON.parse(out) : null;
}

// `gh api --paginate --jq '.[]'`: one JSON value per line.
export function ghLines(gh, args) {
  return ghOk(gh, [...args, '--paginate', '--jq', '.[]'])
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export const prNumber = (pr) => Number(/\/pull\/(\d+)/.exec(String(pr))?.[1] ?? String(pr).replace(/^#/, '')) || null;
const commentId = (c) => Number(/issuecomment-(\d+)/.exec(c.url ?? '')?.[1] ?? 0) || null;

const PR_FIELDS = 'number,url,state,author,createdAt,mergedAt,closedAt,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,labels,body,title,isDraft';

export function prView(gh, repo, pr) {
  const p = ghJson(gh, ['pr', 'view', String(pr), '-R', repo, '--json', PR_FIELDS]);
  return { ...p, author: p.author?.login ?? p.author ?? null, labels: (p.labels ?? []).map((l) => l.name ?? l) };
}

export const prFiles = (gh, repo, pr) => (ghJson(gh, ['pr', 'view', String(pr), '-R', repo, '--json', 'files'])?.files ?? []).map((f) => f.path);

// 'success' | 'pending' | 'failure' | null (no checks reported yet).
export function checksState(gh, repo, pr) {
  const r = gh(['pr', 'checks', String(pr), '-R', repo, '--json', 'name,state,bucket']);
  let checks;
  try {
    checks = JSON.parse(String(r.stdout ?? '').trim() || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(checks) || !checks.length) return null;
  const buckets = checks.map((c) => String(c.bucket ?? c.state ?? '').toLowerCase());
  if (buckets.some((b) => ['fail', 'cancel', 'failure', 'error', 'cancelled'].includes(b))) return 'failure';
  if (buckets.some((b) => ['pending', 'queued', 'in_progress', 'expected'].includes(b))) return 'pending';
  return 'success';
}

export function issueAssignees(gh, repo, number) {
  return (ghJson(gh, ['issue', 'view', String(number), '-R', repo, '--json', 'assignees'])?.assignees ?? []).map((a) => a.login ?? a);
}

export const issueBody = (gh, repo, number) => ghJson(gh, ['issue', 'view', String(number), '-R', repo, '--json', 'body'])?.body ?? '';
export const setIssueBody = (gh, repo, number, body) => ghOk(gh, ['issue', 'edit', String(number), '-R', repo, '--body-file', '-'], { input: body });

const LABEL_COLORS = { 'needs-human': 'b60205', 'auto-merged': '0e8a16', reopened: 'd93f0b' };
export function ensureLabel(gh, repo, name, description = '') {
  gh(['label', 'create', name, '-R', repo, '--color', LABEL_COLORS[name] ?? (name.startsWith('approvals:') ? 'fbca04' : 'ededed'), '--description', description || 'Set by the review gate', '--force']);
}

export function editPrLabels(gh, repo, pr, { add = [], remove = [] }) {
  for (const l of add) ensureLabel(gh, repo, l);
  if (!add.length && !remove.length) return;
  ghOk(gh, ['pr', 'edit', String(pr), '-R', repo, ...(add.length ? ['--add-label', add.join(',')] : []), ...(remove.length ? ['--remove-label', remove.join(',')] : [])]);
}

export function addIssueLabel(gh, repo, number, label) {
  ensureLabel(gh, repo, label);
  ghOk(gh, ['issue', 'edit', String(number), '-R', repo, '--add-label', label]);
}

// Requests reviews; a login GitHub refuses (not a collaborator) is skipped, not fatal. Returns the
// logins requested.
export function requestReviewers(gh, repo, pr, logins) {
  const done = [];
  for (const l of logins) {
    const r = gh(['pr', 'edit', String(pr), '-R', repo, '--add-reviewer', l]);
    if (r.status === 0) done.push(l);
  }
  return done;
}

// The PR comment carrying `marker`, or null: { id, body, url }.
export function findComment(gh, repo, pr, marker) {
  const comments = ghJson(gh, ['pr', 'view', String(pr), '-R', repo, '--json', 'comments'])?.comments ?? [];
  const c = comments.filter((x) => String(x.body ?? '').includes(marker)).at(-1);
  return c ? { id: commentId(c), body: c.body, url: c.url ?? null } : null;
}

// Adds or edits (in place) the PR comment that carries `marker`.
export function upsertComment(gh, repo, pr, marker, body) {
  const existing = findComment(gh, repo, pr, marker);
  if (existing?.id) {
    ghOk(gh, ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', '-'], { input: JSON.stringify({ body }) });
    return existing.url;
  }
  return ghOk(gh, ['pr', 'comment', String(pr), '-R', repo, '--body-file', '-'], { input: body }).trim();
}

export const prReviews = (gh, repo, pr) => ghLines(gh, ['api', `repos/${repo}/pulls/${prNumber(pr)}/reviews`]);
export const prReviewComments = (gh, repo, pr) => ghLines(gh, ['api', `repos/${repo}/pulls/${prNumber(pr)}/comments`]);
export const prCommits = (gh, repo, pr) => ghLines(gh, ['api', `repos/${repo}/pulls/${prNumber(pr)}/commits`]);

// ---------------------------------------------------------------------------------------------
// Merging: the one function every merge goes through
// ---------------------------------------------------------------------------------------------

// Who merges (implement.autoMerge.identity):
//   gh-user  the gh CLI's logged-in user (today; works while main requires no approvals from people)
//   app      a GitHub App with a ruleset bypass, once approvals are required: its installation token
//            in the environment variable `appTokenEnv` (REVIEW_GATE_APP_TOKEN) becomes GH_TOKEN
export function mergeIdentity(settings, env = process.env) {
  const identity = settings?.identity ?? 'gh-user';
  if (identity === 'gh-user') return { identity, env: undefined };
  if (identity === 'app') {
    const name = settings.appTokenEnv ?? 'REVIEW_GATE_APP_TOKEN';
    if (!env[name]) throw new Error(`implement.autoMerge.identity is "app" but ${name} is not set (the GitHub App's installation token)`);
    return { identity, env: { ...env, GH_TOKEN: env[name] } };
  }
  throw new Error(`implement.autoMerge.identity must be "gh-user" or "app", not "${identity}"`);
}

// `gh pr merge --auto --squash`: GitHub merges once its own requirements are met (at once when there
// are none). Throws when the merge is refused.
export function mergePr(gh, repo, pr, settings) {
  const { identity, env } = mergeIdentity(settings);
  const method = settings?.method ?? 'squash';
  ghOk(gh, ['pr', 'merge', String(pr), '-R', repo, '--auto', `--${method}`], { env });
  return { identity, method };
}

export const disableAutoMerge = (gh, repo, pr) => gh(['pr', 'merge', String(pr), '-R', repo, '--disable-auto']);
