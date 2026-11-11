// `board fetch | publish | new | migrate`: the ticket content commands (bodies, assets, cache,
// migration). The lane commands (move, pick, review, ...) stay in board.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { listTickets, resetTicketMemo } from '../../pipeline/lib/tickets.mjs';
import { buildAssetsCommit, exec, pushAssetsBranch } from './assets.mjs';
import { blockersOf } from '../../implement/lib/batch.mjs';
import { epicSlugOf } from './board.mjs';
import { isBug, kebab, walkFiles } from './legacy.mjs';
import { STORY_FOOTER, applyMigration, deleteLocal, formatPlan, labelsFor, planMigration, verifyMigration, writeReport } from './migrate.mjs';
import { boardAvailable, epicChildren, fetchTickets, issueIndex, readMeta, ticketFile, writeTicket } from './source.mjs';
import { keepDecisions } from './escalation.mjs';
import { keepTriage } from '../../review-gate/lib/triage-section.mjs';
import { renderBody, sha256 } from './ticket-format.mjs';

const defaultGh = (args, opts = {}) => exec('gh', args, opts);
const QE_CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../qe/qe.mjs');

function requireBoard(config) {
  if (boardAvailable(config)) return true;
  console.error(`The board is not reachable from this checkout: origin must be ${config.tickets.repo} (and PIPELINE_BOARD / PIPELINE_TICKETS_OFFLINE unset), with gh logged in.`);
  return false;
}

// board fetch <KEY...> | --epic <EPIC> | --all [--refresh]
export function fetchCommand(config, { keys, epic, all, refresh, gh = defaultGh, log = console.error }) {
  if (!keys.length && !epic && !all) {
    console.error('Usage: board fetch <KEY...> | --epic <EPIC> | --all [--refresh]');
    return 2;
  }
  let wanted = keys.map((k) => (/^(epic|spike)-/i.test(k) ? k.toLowerCase() : k.toUpperCase()));
  let index;
  if (boardAvailable(config)) {
    try {
      index = issueIndex(config, { gh });
      if (all) wanted = [...index.keys()];
      if (epic) {
        const epicKey = /^epic-/i.test(epic) ? epic.toLowerCase() : `epic-${kebab(epic)}`;
        wanted.push(epicKey, ...epicChildren(config, epicKey, { gh, index }));
      }
    } catch (error) {
      log(`warning: GitHub unreachable (${error.message.split('\n')[0]}); using the cache`);
    }
  } else if (all || epic) {
    log('warning: the board is not reachable from this checkout; showing the cache');
    wanted.push(...listTickets(config).filter((t) => all || t.epic === epic || t.key === epic).map((t) => t.key));
  }
  const results = fetchTickets(config, [...new Set(wanted)], { refresh, gh, index, log });
  resetTicketMemo();
  let failed = 0;
  for (const r of results) {
    const where = path.relative(config.root, ticketFile(config, r.key));
    if (['missing', 'error'].includes(r.status)) failed++;
    console.log(`${r.key.padEnd(12)} ${r.status.padEnd(13)} ${['missing', 'error'].includes(r.status) ? r.message : where}${r.message && !['missing', 'error'].includes(r.status) ? `  (${r.message})` : ''}`);
  }
  // Stories are not commits any more, so a changed story starts its test plan here (opt-in, like the
  // old post-commit trigger): git config qe.autoPlan true.
  const changed = results.filter((r) => r.status === 'fetched' && ['story', 'bug'].includes(readMeta(config, r.key)?.type)).map((r) => r.key);
  if (changed.length && git(config.root, ['config', '--bool', 'qe.autoPlan']).stdout.trim() === 'true' && process.env.PIPELINE_CHILD !== '1') {
    const bg = spawnBackground(config, { script: QE_CLI, key: changed[0], stage: 'qe', args: ['plan', ...changed] });
    console.log(`Stories changed (${changed.join(', ')}); writing test plans in the background (log ${bg.log}).`);
  }
  return failed ? 1 : 0;
}

// board publish <KEY> [--force]: writes the cached story (for example with the implementer's
// Implementation Notes) back to its issue. The assets stay pinned to the commit the issue already uses.
export function publishCommand(config, { key, force = false, gh = defaultGh }) {
  const meta = readMeta(config, key);
  if (!meta || !fs.existsSync(ticketFile(config, key))) {
    console.error(`${key} is not in the ticket cache.`);
    return 2;
  }
  const text = fs.readFileSync(ticketFile(config, key), 'utf8');
  if (sha256(Buffer.from(text, 'utf8')) === meta.contentHash && !force) {
    console.log(`${key}: unchanged since it was fetched; nothing to publish.`);
    return 0;
  }
  if (!boardAvailable(config)) {
    console.log(`${key}: the board is not reachable from this checkout; not published.`);
    return 0;
  }
  if (!meta.issue?.number) {
    console.error(`${key} has no issue; create it with \`board new\`.`);
    return 2;
  }
  const current = JSON.parse(String(gh(['issue', 'view', String(meta.issue.number), '-R', config.tickets.repo, '--json', 'updatedAt,body,title']).stdout || 'null'));
  if (!current) {
    console.error(`${key}: could not read #${meta.issue.number}.`);
    return 1;
  }
  if (current.updatedAt !== meta.issue.updatedAt && !force) {
    console.error(`${key}: #${meta.issue.number} changed on GitHub since it was fetched (${current.updatedAt}); fetch it, merge your edits, or pass --force to overwrite.`);
    return 1;
  }
  const ticket = { key, type: meta.type, title: meta.title, slug: meta.slug, source: meta.source, parent: meta.parent, blockedBy: ['story', 'bug'].includes(meta.type) ? blockersOf(text, key) : meta.blockedBy };
  // The ## Decisions a human recorded on the issue are outside the source; keep them.
  const body = keepTriage(keepDecisions(renderBody(ticket, text, { assets: meta.assets, footer: ['story', 'bug'].includes(meta.type) ? STORY_FOOTER(config) : '' }).body, current.body), current.body);
  const r = gh(['issue', 'edit', String(meta.issue.number), '-R', config.tickets.repo, '--body-file', '-'], { input: body });
  if (r.status !== 0) {
    console.error(`${key}: gh issue edit failed: ${String(r.stderr).trim()}`);
    return 1;
  }
  const after = JSON.parse(String(gh(['issue', 'view', String(meta.issue.number), '-R', config.tickets.repo, '--json', 'updatedAt']).stdout || '{}'));
  writeTicket(config, key, { content: text, meta: { ...meta, ...ticket, sourceHash: sha256(Buffer.from(text, 'utf8')) }, issue: { ...meta.issue, updatedAt: after.updatedAt ?? meta.issue.updatedAt } });
  console.log(`${key}: published to #${meta.issue.number}.`);
  return 0;
}

// board new <file.md | -> [--type story|bug|epic|spike] [--key KEY] [--epic <epic-key>] [--mockups <dir>]
// Creates a ticket issue from Markdown (the story format in docs/ai-pipeline/writing-stories.md).
export function newCommand(config, { file, type, key: keyArg, epic, mockups, dryRun = false, gh = defaultGh, run = exec, stdin = () => fs.readFileSync(0, 'utf8') }) {
  const text = !file || file === '-' ? stdin() : fs.readFileSync(file, 'utf8');
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!heading) {
    console.error('The Markdown needs a "# <title>" heading (for stories: "# <KEY>: <title>").');
    return 2;
  }
  const headingKey = /^([A-Z][A-Z0-9]*-\d+)\b/.exec(heading)?.[1];
  let key = keyArg?.toUpperCase() ?? headingKey;
  const kind = type ?? (key && isBug(key, text) ? 'bug' : 'story');
  if (['epic', 'spike'].includes(kind)) key = keyArg ?? `${kind}-${kebab(heading.replace(/^(Epic|Spike):\s*/i, ''))}`;
  if (!key) {
    console.error('Give the story key: "# PROMO-10: <title>" in the heading, or --key PROMO-10.');
    return 2;
  }
  const title = kind === 'epic' ? `Epic: ${heading.replace(/^Epic:\s*/i, '')}` : kind === 'spike' ? `Spike: ${heading.replace(/^Spike:\s*/i, '')}` : headingKey ? heading : `${key}: ${heading}`;
  const parent = epic ?? (kind === 'spike' ? null : epicSlugOf(text));
  const ticket = { key, type: kind, title, slug: ['story', 'bug'].includes(kind) ? `${key}-${kebab(title.replace(/^[A-Z][A-Z0-9]*-\d+:?\s*/, '')).slice(0, 60).replace(/-+$/, '')}` : key, source: null, parent, blockedBy: ['story', 'bug'].includes(kind) ? blockersOf(text, key) : [], text };
  if (!dryRun && !requireBoard(config)) return 2;
  const index = dryRun ? new Map() : issueIndex(config, { gh });
  if (index.has(key)) {
    console.error(`${key} already has an issue (#${index.get(key).number}); edit it on GitHub, or fetch it and \`board publish\`.`);
    return 2;
  }
  let assets = { repo: config.tickets.repo, branch: config.tickets.assetsBranch, commit: null, files: [] };
  if (mockups) {
    const dir = path.resolve(mockups);
    const folder = path.basename(dir);
    const files = walkFiles(dir).map((rel) => ({ rel, abs: path.join(dir, rel), data: fs.readFileSync(path.join(dir, rel)) }));
    assets.files = files.map((f) => ({ path: `mockups/${key}/${folder}/${f.rel}`, name: `${folder}/${f.rel}`, kind: 'mockup', sha256: sha256(f.data), size: f.data.length }));
    if (!dryRun) {
      const built = buildAssetsCommit(config, files.map((f, i) => ({ path: assets.files[i].path, data: f.data })), { message: `Mockups for ${key}`, run });
      assets.commit = built.commit;
      if (built.changed) pushAssetsBranch(config, { run });
    }
  }
  const links = Object.fromEntries([parent, ...ticket.blockedBy].filter((k) => k && index.has(k)).map((k) => [k, index.get(k).number]));
  const { body, meta, spilled } = renderBody(ticket, text, { assets, links, footer: ['story', 'bug'].includes(kind) ? STORY_FOOTER(config) : '' });
  if (spilled) {
    console.error(`${key}: the story is too large for an issue body (or has mixed line endings); split it, or migrate it as a file.`);
    return 2;
  }
  const labels = labelsFor(config, ticket);
  if (dryRun) {
    console.log(`Would create ${kind} ${key} "${title}" (labels: ${labels.join(', ')}${parent ? `, sub-issue of ${parent}` : ''}, ${body.length} characters, ${assets.files.length} asset(s)).`);
    return 0;
  }
  const url = String(gh(['issue', 'create', '-R', config.tickets.repo, '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])], { input: body }).stdout).trim();
  const number = Number(url.split('/').pop());
  if (!number) {
    console.error(`gh issue create failed for ${key}.`);
    return 1;
  }
  if (config.board?.projectNumber) gh(['project', 'item-add', String(config.board.projectNumber), '--owner', config.board.owner, '--url', url]);
  if (parent && index.has(parent)) {
    const [owner, name] = config.tickets.repo.split('/');
    const id = (n) => JSON.parse(String(gh(['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`]).stdout)).data.repository.issue.id;
    gh(['api', 'graphql', '-f', 'query=mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c,replaceParent:true}){issue{id}}}', '-f', `p=${id(index.get(parent).number)}`, '-f', `c=${id(number)}`]);
  }
  const view = JSON.parse(String(gh(['issue', 'view', String(number), '-R', config.tickets.repo, '--json', 'updatedAt,state,labels']).stdout || '{}'));
  writeTicket(config, key, { content: text, meta, issue: { number, url, updatedAt: view.updatedAt ?? null, state: view.state ?? 'OPEN', title, labels } });
  console.log(`${key}: created ${url}${parent ? ` under ${parent}` : ''}.`);
  return 0;
}

// board migrate [--summary] | --apply | --verify [--allow-unplaced] | --delete-local [--dry-run]
export function migrateCommand(config, flags, { gh = defaultGh, run = exec } = {}) {
  if (flags['delete-local']) {
    const r = deleteLocal(config, { run, log: (m) => console.log(m), dryRun: Boolean(flags['dry-run']) });
    if (!r.ok) {
      console.error(`Refusing to delete: ${r.reason}.`);
      return 1;
    }
    console.log(`${flags['dry-run'] ? 'Would change' : 'Changed'} ${r.changed.length} path(s).`);
    if (r.remaining.length) {
      console.log(`References left for a human (not a shape migrate knows how to edit):\n${r.remaining.map((l) => `  ${l}`).join('\n')}`);
      return 1;
    }
    console.log(flags['dry-run'] ? 'No other references.' : 'No references to the legacy folder remain. Review and commit the change.');
    return 0;
  }
  if (flags.verify) {
    if (!requireBoard(config)) return 2;
    const report = verifyMigration(config, { gh, run, allowUnplaced: Boolean(flags['allow-unplaced']) });
    console.log(`Verify ${report.passed ? 'PASSED' : 'FAILED'}: ${report.tickets.length} ticket(s), ${report.differences.length} difference(s). Report: ${path.relative(config.root, report.reportFile)}`);
    return report.passed ? 0 : 1;
  }
  if (flags.apply) {
    if (!requireBoard(config)) return 2;
    const r = applyMigration(config, { gh, run, log: (m) => console.log(m) });
    resetTicketMemo();
    console.log(`Applied: ${r.created.length} created, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.linked} sub-issue link(s); assets at ${r.commit ? r.commit.slice(0, 10) : '(none)'}. Next: board migrate --verify`);
    return 0;
  }
  const plan = planMigration(config, { gh: boardAvailable(config) ? gh : () => ({ status: 1, stdout: '', stderr: 'board not reachable from this checkout' }) });
  const file = writeReport(config, 'plan', plan, formatPlan(plan));
  console.log(formatPlan(plan, { summary: true }));
  console.log(`\nDry run. Full plan: ${path.relative(config.root, file)} (and .json). Apply with --apply.`);
  return 0;
}
