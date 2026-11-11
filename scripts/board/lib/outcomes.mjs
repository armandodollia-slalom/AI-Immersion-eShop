// Late outcomes of pipeline-implemented stories, for the implement stage's decision log: when a card
// reaches Done, whether its PR merged, what humans committed on the branch before merge, and which
// later BUG-* stories name it. Appended to .agent-metrics/decision-outcomes.jsonl in this checkout
// (not committed here; it travels with the next commit that includes .agent-metrics/).
import fs from 'node:fs';
import path from 'node:path';
import { git, revExists } from '../../pipeline/lib/git.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { appendJsonl, nowIso, readJson, readJsonl } from '../../pipeline/lib/util.mjs';
import { OUTCOMES_FILE, bugStoriesFor, humanCommitStats, lateOutcomeRecord } from '../../implement/lib/decisions.mjs';
import { ghJson } from './github.mjs';

export function recordLateOutcome(config, key, { listStories }) {
  const run = readJson(path.join(config.root, config.stateDir, 'implement', `${key}.json`), null);
  if (!run?.branch) return null; // not implemented by `pipeline implement` on this machine
  const file = metricsFile(config, OUTCOMES_FILE);
  if (readJsonl(file).some((r) => r.type === 'late' && r.story === key)) return null;
  const prs = ghJson(['pr', 'list', '-R', config.board.repo, '--head', run.branch, '--state', 'all', '--json', 'number,state,url,commits']);
  const pr = prs.find((p) => p.state === 'MERGED') ?? prs[0] ?? null;
  git(config.root, ['fetch', '-q', 'origin', run.branch]);
  const commits = (pr?.commits ?? []).map((c) => {
    const exists = revExists(config.root, c.oid);
    const lines = exists
      ? git(config.root, ['show', '--numstat', '--format=', c.oid]).stdout.split('\n').filter(Boolean).reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((m, x) => m + (Number(x) || 0), 0), 0)
      : null;
    return { oid: c.oid, lines, authors: (c.authors ?? []).map((a) => a.login || a.email || a.name).filter(Boolean), exists };
  });
  const finalSha = run.finalSha && revExists(config.root, run.finalSha) ? run.finalSha : null;
  const isPipeline = (c) => (finalSha && c.exists ? git(config.root, ['merge-base', '--is-ancestor', c.oid, finalSha]).status === 0 : false);
  const stories = listStories(config).map((s) => ({ key: s.key, text: fs.existsSync(path.join(config.root, s.file)) ? fs.readFileSync(path.join(config.root, s.file), 'utf8') : '' }));
  const rec = lateOutcomeRecord({
    ts: nowIso(),
    key,
    decisionId: run.decisionId ?? run.orchestration?.decisionId ?? null,
    pr: pr?.url ?? null,
    prMerged: pr?.state === 'MERGED',
    stats: finalSha ? humanCommitStats(commits, { isPipeline }) : null,
    bugStories: bugStoriesFor(key, stories),
  });
  appendJsonl(file, rec);
  return rec;
}
