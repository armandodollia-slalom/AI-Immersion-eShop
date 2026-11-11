#!/usr/bin/env node
// PR demo videos: records the e2e specs a pull request changes and adds the videos to the PR
// description. Run by .github/workflows/pr-demo-video.yml; see docs/ai-pipeline/pr-demo-video.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../pipeline/lib/cli.mjs';
import { repoRoot } from '../pipeline/lib/config.mjs';
import { log, setLogTag } from '../pipeline/lib/util.mjs';
import { repoSlug } from '../pr-check/lib/github.mjs';
import { API_MARKERS, DEFAULT_OPENAPI, allEndpoints, buildApiSummary, changeScope, changedEndpoints, loadOpenApi, recordedExchanges, renderApiSection } from './lib/api-summary.mjs';
import { changedSpecs, prFolder, publishFolder, renderSection, stageVideos, writePrSection } from './lib/pr-video.mjs';

setLogTag('pr-video');

const USAGE = `Usage: node scripts/pr-video/pr-video.mjs <command> [options]

  specs --base <ref>
        Print the e2e/teststack specs changed since the merge base with <ref>, one per line.
  publish --pr <n> [--specs <a,b>] [--videos-dir artifacts/e2e-videos] [--note <text>] [--remove]
          [--branch pr-videos] [--head-sha <sha>] [--run-url <url>]
        Push the recorded videos to the storage branch and update the PR's "Demo video" section.
        --note writes the note instead of videos (and removes the PR's old videos). --remove removes
        the section and the PR's videos (for PRs that don't change the frontend).
  scope --base <ref>
        Print what the PR changes as key=value lines (for $GITHUB_OUTPUT): frontend, backend,
        video (frontend changed) and api (backend changed, frontend not).
  api --base <ref> (--pr <n> | --dry-run) [--manifest artifacts/e2e-videos/manifest.json]
      [--openapi <url,url>] [--specs <a,b>] [--head-sha <sha>] [--run-url <url>]
        Document the HTTP endpoints the PR adds, changes or removes (method, route, parameters, request
        and response types from OpenAPI, and example calls recorded with E2E_API_LOG=1) in the PR's
        "API changes" section, or print it with --dry-run. Only for backend-only PRs; removes the section
        when the PR also changes the frontend or there is nothing to show.
  cleanup --pr <n> [--branch pr-videos]
        Remove the PR's videos from the storage branch.

Needs git push access and the gh CLI (GH_TOKEN).`;

const VALUE_FLAGS = new Set(['base', 'pr', 'specs', 'videos-dir', 'note', 'branch', 'head-sha', 'run-url', 'manifest', 'openapi']);

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), VALUE_FLAGS);
  const [command] = positional;
  const root = repoRoot();
  const branch = flags.branch ?? 'pr-videos';
  const pr = Number(flags.pr);

  if (command === 'specs') {
    if (!flags.base) throw new Error('specs needs --base <ref>');
    for (const spec of changedSpecs(root, flags.base)) console.log(spec);
    return 0;
  }
  if (command === 'scope') {
    if (!flags.base) throw new Error('scope needs --base <ref>');
    for (const [key, value] of Object.entries(changeScope(root, flags.base))) console.log(`${key}=${value}`);
    return 0;
  }
  if (command === 'api') {
    if (!flags.base) throw new Error('api needs --base <ref>');
    if (!(pr > 0) && !flags['dry-run']) throw new Error('api needs --pr <n> or --dry-run');
    const scope = changeScope(root, flags.base);
    if (!scope.api) {
      const reason = scope.frontend ? 'the PR changes the frontend' : 'the PR changes no backend code';
      if (flags['dry-run']) console.log(`(no API changes section: ${reason})`);
      else {
        writePrSection(root, pr, null, API_MARKERS);
        log(`PR #${pr}: no API changes section (${reason})`);
      }
      return 0;
    }
    const manifestFile = path.resolve(root, flags.manifest ?? 'artifacts/e2e-videos/manifest.json');
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
    const urls = flags.openapi ? String(flags.openapi).split(',').filter(Boolean) : DEFAULT_OPENAPI;
    const endpoints = buildApiSummary({
      changed: changedEndpoints(root, flags.base),
      known: allEndpoints(root),
      exchanges: recordedExchanges(manifest),
      docs: await loadOpenApi(urls),
    });
    const specs = String(flags.specs ?? '').split(',').filter(Boolean);
    const section = renderApiSection({ endpoints, headSha: flags['head-sha'], runUrl: flags['run-url'], specs });
    if (flags['dry-run']) {
      console.log(section ?? '(no API changes)');
      return 0;
    }
    writePrSection(root, pr, section, API_MARKERS);
    log(`PR #${pr}: ${section ? `API changes section lists ${endpoints.length} endpoint(s)` : 'no API changes, section removed'}`);
    return 0;
  }
  if (command === 'publish' || command === 'cleanup') {
    if (!(pr > 0)) throw new Error(`${command} needs --pr <n>`);
    const folder = prFolder(pr);
    if (command === 'cleanup') {
      const r = publishFolder(root, { branch, folder, stageDir: null, message: `Remove demo videos of PR #${pr}` });
      log(r.pushed ? `removed ${folder} from ${branch}` : `${branch} has no ${folder}`);
      return 0;
    }
    if (flags.remove) {
      publishFolder(root, { branch, folder, stageDir: null, message: `Remove demo videos of PR #${pr}` });
      writePrSection(root, pr, null);
      log(`PR #${pr}: no frontend changes, demo video section removed`);
      return 0;
    }
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-stage-'));
    try {
      const videos = flags.note ? [] : stageVideos(path.resolve(root, flags['videos-dir'] ?? 'artifacts/e2e-videos'), stageDir);
      const specs = String(flags.specs ?? '').split(',').filter(Boolean);
      const note = flags.note || (videos.length ? null : 'The changed e2e specs recorded no video (API-only tests have no browser, or the run failed before any test started).');
      publishFolder(root, { branch, folder, stageDir: videos.length ? stageDir : null, message: `Demo videos of PR #${pr}${flags['head-sha'] ? ` at ${flags['head-sha'].slice(0, 7)}` : ''}` });
      const section = renderSection({ repo: repoSlug(root), branch, pr, headSha: flags['head-sha'], runUrl: flags['run-url'], specs, videos, note });
      writePrSection(root, pr, section);
      log(`PR #${pr}: ${videos.length ? `${videos.length} video(s) published to ${branch}/${folder}` : 'note written'}`);
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    return 0;
  }
  console.error(USAGE);
  return command ? 64 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[pr-video] ${error.message}`);
    process.exit(1);
  },
);
