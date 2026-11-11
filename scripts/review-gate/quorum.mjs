#!/usr/bin/env node
// The `review-quorum` check (.github/workflows/review-quorum.yml): passes when approvals from distinct
// people (not stale approvals from before the latest push) reach the PR's `approvals:N` label. With
// --author-can-approve the PR's author counts too, by a Comment review whose body is `/approve`. A PR
// without that label, or with `approvals:0`, passes. Self-contained (only the gh CLI and
// lib/quorum.mjs), so the workflow runs it from the base branch, never the PR's own copy.
//
//   node scripts/review-gate/quorum.mjs <pr number> [--repo owner/name] [--author-can-approve]
import { spawnSync } from 'node:child_process';
import { quorum } from './lib/quorum.mjs';

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a)) ?? process.env.PR_NUMBER;
const repoAt = args.indexOf('--repo');
const repo = repoAt >= 0 ? args[repoAt + 1] : process.env.GITHUB_REPOSITORY;
if (!pr || !repo) {
  console.error('Usage: quorum.mjs <pr number> --repo owner/name (or PR_NUMBER and GITHUB_REPOSITORY)');
  process.exit(2);
}

const gh = (a) => {
  const r = spawnSync('gh', a, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh ${a.slice(0, 2).join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
};
const p = JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}`]));
const reviews = gh(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--jq', '.[]'])
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const result = quorum({ labels: p.labels, reviews, author: p.user?.login, headSha: p.head?.sha, authorCanApprove: args.includes('--author-can-approve') });
console.log(`review-quorum: ${result.pass ? 'pass' : 'fail'}: ${result.summary}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### review-quorum: ${result.pass ? 'pass' : 'waiting for approvals'}\n\n${result.summary}\n`);
}
process.exit(result.pass ? 0 : 1);
