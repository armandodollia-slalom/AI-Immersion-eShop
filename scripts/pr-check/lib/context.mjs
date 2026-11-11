// Works out what the PR check reviews: the pull request, its story, the code to read (the current
// checkout, or a detached worktree at the PR head), the diff against the base, and the references
// (mockups, conventions) the critics compare it with.
import fs from 'node:fs';
import path from 'node:path';
import { currentBranch, git, revExists } from '../../pipeline/lib/git.mjs';
import { activeStory, resolveStory } from '../../pipeline/lib/stories.mjs';
import { epicTickets, loadTicket, mockupFiles } from '../../pipeline/lib/tickets.mjs';
import { log } from '../../pipeline/lib/util.mjs';
import { fetchPullRequest } from './github.mjs';

const toPosix = (p) => p.replace(/\\/g, '/');
const excludeSpecs = (config) => ['--', '.', ...config.prCheck.exclude.map((p) => `:(exclude)${p}`)];

function storyFromText(config, texts) {
  for (const text of texts.filter(Boolean)) {
    for (const match of String(text).toUpperCase().matchAll(/([A-Z][A-Z0-9]*-\d+)/g)) {
      const story = resolveStory(config, match[1]);
      if (story) return story;
    }
  }
  return null;
}

function checkoutAt(config, id, sha) {
  const dir = path.join(config.root, config.stateDir, 'pr-check-checkouts', id);
  if (fs.existsSync(dir)) {
    git(config.root, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
    git(config.root, ['worktree', 'prune']);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(config.root, ['worktree', 'add', '--detach', dir, sha], { allowFail: false });
  // Critics query graphify first; the main checkout's graph is close enough for a PR's worth of change.
  const graph = path.join(config.root, 'graphify-out');
  if (fs.existsSync(path.join(graph, 'graph.json'))) fs.cpSync(graph, path.join(dir, 'graphify-out'), { recursive: true });
  return dir;
}

export function removeCheckout(config, ctx) {
  if (ctx.workRoot === config.root) return;
  git(config.root, ['worktree', 'remove', '--force', ctx.workRoot]);
  git(config.root, ['worktree', 'prune']);
}

// The tickets of a multi-ticket check (an epic delivered on one branch): the stories given with --stories,
// else the epic's stories and bugs, plus the epic itself (its body and mockups describe the journey).
function ticketSet(config, { stories = [], epic = null }) {
  const epicTicket = epic ? loadTicket(config, String(epic).startsWith('epic-') ? epic : `epic-${String(epic).toLowerCase()}`) : null;
  if (epic && !epicTicket) throw new Error(`unknown epic "${epic}"`);
  const keys = stories.length ? stories : epicTicket ? epicTickets(config, epicTicket.key).map((t) => t.key) : [];
  const tickets = keys.map((k) => {
    const t = resolveStory(config, k);
    if (!t) throw new Error(`unknown story "${k}"`);
    return t;
  });
  if (epic && !tickets.length) throw new Error(`epic ${epicTicket.key} has no stories on the board (or in the ticket cache)`);
  return { tickets, epic: epicTicket };
}

// One ticket of the check, as the critics get it: its story file, title, mockups and whether it is frontend.
function ticketRef(config, t) {
  const text = fs.readFileSync(config.abs(t.file), 'utf8');
  const title = text.split('\n')[0].replace(/^#\s*/, '').trim();
  const mockups = mockupFiles(config, t.key).map((f) => config.abs(f));
  return { key: t.key, title, file: config.abs(t.file), dir: config.abs(t.dir), mockups, frontend: /\[FE\b/i.test(title) || mockups.length > 0 };
}

export async function resolveTarget(config, { pr: prNumber, story: storyArg, stories: storiesArg = [], epic: epicArg = null, base, fix }) {
  const pr = prNumber ? await fetchPullRequest(config.root, prNumber) : null;
  const branch = currentBranch(config.root);
  const set = storiesArg.length || epicArg ? ticketSet(config, { stories: storiesArg, epic: epicArg }) : null;
  const story = storyArg ? resolveStory(config, storyArg) : set?.tickets[0] ?? storyFromText(config, [pr?.headRef, pr?.title, branch, pr?.body]) ?? activeStory(config);
  if (storyArg && !story) throw new Error(`unknown story "${storyArg}"`);
  if (!story) throw new Error('no story found for this PR: pass --story <KEY> (the check compares the PR with its story)');
  const setKeys = set ? [...new Set([story.key, ...set.tickets.map((t) => t.key)])] : [story.key];
  const id = pr ? `pr-${pr.number}` : set?.epic ? set.epic.key : setKeys.length > 1 ? `${setKeys[0]}+${setKeys.length - 1}` : story.key;

  let workRoot = config.root;
  const headMatches = pr && branch === pr.headRef && (!pr.headSha || git(config.root, ['rev-parse', 'HEAD']).stdout.trim() === pr.headSha);
  if (pr && fix && branch === pr.headRef && !headMatches) {
    throw new Error(`the local ${branch} is not at the PR head ${pr.headSha.slice(0, 10)}; pull or push so they match, or pass --no-fix`);
  }
  if (pr && !headMatches) {
    if (fix) throw new Error(`to let the loop fix findings, check out the PR branch first (git switch ${pr.headRef}, or gh pr checkout ${pr.number}); or pass --no-fix for a report-only check`);
    const fetched = git(config.root, ['fetch', '--quiet', 'origin', `pull/${pr.number}/head`]);
    if (fetched.status !== 0) throw new Error(`git fetch of PR #${pr.number} failed: ${fetched.stderr.trim()}`);
    const sha = git(config.root, ['rev-parse', 'FETCH_HEAD']).stdout.trim();
    workRoot = checkoutAt(config, id, sha);
    log(`PR #${pr.number} is not checked out; reviewing it in ${path.relative(config.root, workRoot)}`);
  }

  const baseRef = base ?? (pr ? `origin/${pr.baseRef}` : config.baseRef);
  if (pr) git(config.root, ['fetch', '--quiet', 'origin', pr.baseRef]);
  const baseCandidates = [baseRef, 'origin/main', 'main'].filter((ref) => revExists(workRoot, ref));
  if (!baseCandidates.length) throw new Error(`base ${baseRef} not found`);
  const baseRev = git(workRoot, ['merge-base', 'HEAD', baseCandidates[0]], { allowFail: false }).stdout.trim();

  // The story and its mockups come from the ticket cache of this checkout (fetched from the board), not
  // from the PR's tree: the board is the source of truth. Mockup paths are absolute so agents working in
  // a PR checkout can open them, and the story guard lets the check's agents read exactly this ticket.
  // A multi-ticket check (--stories, --epic) holds the PR to every ticket, and the epic's body and mockups
  // describe the journey across them.
  const storyText = fs.readFileSync(config.abs(story.file), 'utf8');
  const tickets = setKeys.map((k) => ticketRef(config, k === story.key ? story : set.tickets.find((t) => t.key === k)));
  const epic = set?.epic ? ticketRef(config, set.epic) : null;
  const mockups = [...new Set([...tickets, ...(epic ? [epic] : [])].flatMap((t) => t.mockups))];
  process.env.PIPELINE_STORY_SOURCES = [process.env.PIPELINE_STORY_SOURCES, ...[...tickets, ...(epic ? [epic] : [])].map((t) => t.dir)].filter(Boolean).join(path.delimiter);
  const conventions = config.prCheck.conventions.filter((f) => fs.existsSync(path.join(workRoot, f)));

  const ctx = { id, pr, story, storyTitle: storyText.split('\n')[0].replace(/^#\s*/, '').trim(), branch: pr?.headRef ?? branch, workRoot, baseRef: baseCandidates[0], baseRev, mockups, conventions, tickets, epic, multi: tickets.length > 1 || Boolean(epic) };
  const { files } = prDiff(config, ctx);
  const frontendHit = (f) => config.prCheck.frontendPaths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f.endsWith(p)));
  ctx.isFrontend = tickets.some((t) => t.frontend) || mockups.length > 0 || files.some(frontendHit);
  return ctx;
}

// The PR's changes: the working tree of the checkout (so uncommitted work counts) against the merge
// base, including new untracked files, minus pipeline bookkeeping.
export function prDiff(config, ctx) {
  const specs = excludeSpecs(config);
  const run = (args) => git(ctx.workRoot, args).stdout;
  const tracked = run(['diff', '--name-only', ctx.baseRev, ...specs]).split('\n').filter(Boolean);
  const untracked = run(['ls-files', '--others', '--exclude-standard', ...specs]).split('\n').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].sort();
  const stat = run(['diff', '--stat', ctx.baseRev, ...specs]);
  let diff = run(['diff', '--no-ext-diff', ctx.baseRev, ...specs]);
  for (const file of untracked) {
    const buffer = fs.readFileSync(path.join(ctx.workRoot, file));
    const text = buffer.includes(0) ? '(binary file)' : buffer.toString('utf8');
    diff += `\n--- /dev/null\n+++ b/${file} (new, untracked)\n${text.split('\n').map((l) => `+${l}`).join('\n')}\n`;
  }
  const max = config.prCheck.maxDiffChars;
  if (diff.length > max) diff = `${diff.slice(0, max)}\n... diff truncated at ${max} chars; read the remaining changed files directly.`;
  return { files: files.map(toPosix), stat, diff };
}

export function isClean(config, ctx) {
  return git(ctx.workRoot, ['status', '--porcelain', ...excludeSpecs(config)]).stdout.trim() === '';
}

// Commits whatever the fixer changed. Pipeline hooks are switched off for this commit: the PR check
// is already the reviewer.
export function commitFixes(config, ctx, message) {
  if (isClean(config, ctx)) return null;
  const env = { ...process.env, PIPELINE_CHILD: '1' };
  // Exclude pathspecs that name gitignored folders make `git add` fail, so stage everything and unstage them.
  git(ctx.workRoot, ['add', '-A', '--', '.'], { allowFail: false, env });
  git(ctx.workRoot, ['reset', '-q', '--', ...config.prCheck.exclude], { env });
  if (git(ctx.workRoot, ['diff', '--cached', '--quiet']).status === 0) return null;
  git(ctx.workRoot, ['commit', '--quiet', '-m', message], { allowFail: false, env });
  return git(ctx.workRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim();
}
