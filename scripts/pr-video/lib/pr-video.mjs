// PR demo videos: pick the e2e specs a pull request changes, publish the videos they record to a
// storage branch, and keep a "Demo video" section in the PR description up to date. The PR check's
// video critic reads the links in that section (scripts/pr-check/lib/video.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { log, run } from '../../pipeline/lib/util.mjs';

export const SECTION_START = '<!-- pr-demo-video:start -->';
export const SECTION_END = '<!-- pr-demo-video:end -->';
export const SPEC_PATTERN = /^e2e\/teststack\/[^/]+\.spec\.ts$/;
const GIF_MAX_BYTES = 9 * 1024 * 1024;
const GIF_ATTEMPTS = [
  { fps: 6, width: 720 },
  { fps: 4, width: 480 },
];

export const prFolder = (pr) => `pr-${pr}`;

// Specs added or changed between the merge base and HEAD.
export function changedSpecs(root, base) {
  const diff = git(root, ['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`], { allowFail: false });
  return diff.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => SPEC_PATTERN.test(f) && fs.existsSync(path.join(root, f)));
}

// Replaces the managed section (between `start` and `end`), or appends it when the body has none.
export function upsertSection(body, section, { start: startMarker = SECTION_START, end: endMarker = SECTION_END } = {}) {
  const block = `${startMarker}\n${section.trim()}\n${endMarker}`;
  const text = body ?? '';
  const start = text.indexOf(startMarker);
  const end = start === -1 ? -1 : text.indexOf(endMarker, start);
  if (end !== -1) return `${text.slice(0, start)}${block}${text.slice(end + endMarker.length)}`;
  return text.trim() ? `${text.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

// Removes a managed section, if present.
export function removeSection(body, { start: startMarker = SECTION_START, end: endMarker = SECTION_END } = {}) {
  const text = body ?? '';
  const start = text.indexOf(startMarker);
  const end = start === -1 ? -1 : text.indexOf(endMarker, start);
  if (end === -1) return text;
  return `${text.slice(0, start).trimEnd()}\n${text.slice(end + endMarker.length).replace(/^\n+/, '\n')}`.trim() + '\n';
}

// Tests from artifacts/e2e-videos/manifest.json that kept a video, last attempt of each test only.
export function recordedTests(manifest) {
  const latest = new Map();
  for (const t of manifest?.tests ?? []) {
    const key = [t.project, t.file, ...t.titlePath].join('\u0000');
    if (!latest.has(key) || latest.get(key).retry <= t.retry) latest.set(key, t);
  }
  return [...latest.values()].filter((t) => t.videos.length);
}

const blobUrl = (repo, branch, file) => `https://github.com/${repo}/blob/${branch}/${file.split('/').map(encodeURIComponent).join('/')}`;

export function renderSection({ repo, branch, pr, headSha, runUrl, specs = [], videos = [], note }) {
  const lines = ['## Demo video', ''];
  const source = `${headSha ? `commit ${headSha.slice(0, 7)}` : 'this PR'}${runUrl ? `, [workflow run](${runUrl})` : ''}`;
  if (note) {
    lines.push(`${note} (${source})`);
    return lines.join('\n');
  }
  lines.push(`Recorded on the test stack from the e2e specs this PR changes: ${specs.map((s) => `\`${s}\``).join(', ')} (${source}).`);
  for (const v of videos) {
    lines.push('', `### ${v.ok ? '✅' : '❌ (failed)'} ${v.title}`, '');
    const video = blobUrl(repo, branch, `${prFolder(pr)}/${v.video}`);
    if (v.preview) lines.push(`[![${v.title}](${blobUrl(repo, branch, `${prFolder(pr)}/${v.preview}`)}?raw=true)](${video})`, '');
    lines.push(`[Full video (WebM)](${video}) · \`${v.file}\``);
  }
  lines.push('', '<sub>Updated by `.github/workflows/pr-demo-video.yml` on every push; edits inside this section are overwritten.</sub>');
  return lines.join('\n');
}

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'video';

// Animated preview shown inline in the PR. Skipped (link only) without ffmpeg or when it gets too big.
function makePreview(video, out) {
  if (run('ffmpeg', ['-version']).status !== 0) return false;
  for (const { fps, width } of GIF_ATTEMPTS) {
    const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`;
    const result = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', filter, '-loop', '0', out]);
    if (result.status === 0 && fs.existsSync(out) && fs.statSync(out).size <= GIF_MAX_BYTES) return true;
    log(`preview ${path.basename(out)} at ${fps} fps/${width}px ${result.status === 0 ? 'is too large' : `failed: ${result.stderr.trim()}`}`);
  }
  fs.rmSync(out, { force: true });
  return false;
}

// Copies the recorded videos (and previews) into a staging folder laid out as on the storage branch.
export function stageVideos(videosDir, stageDir) {
  const manifestFile = path.join(videosDir, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  fs.mkdirSync(stageDir, { recursive: true });
  const staged = [];
  for (const t of recordedTests(manifest)) {
    t.videos.forEach((rel, i) => {
      const name = `${slug(`${path.basename(t.file).replace(/\.spec\.ts$/, '')}--${t.title}`)}${t.videos.length > 1 ? `--page${i + 1}` : ''}${t.ok ? '' : '.failed'}`;
      fs.copyFileSync(path.join(videosDir, rel), path.join(stageDir, `${name}.webm`));
      const preview = makePreview(path.join(stageDir, `${name}.webm`), path.join(stageDir, `${name}.gif`)) ? `${name}.gif` : null;
      // titlePath is [project, file, ...describes, title]
      staged.push({ title: t.titlePath.slice(2).join(' › ') || t.title, file: t.file, ok: t.ok, video: `${name}.webm`, preview });
    });
  }
  return staged;
}

// Rewrites the storage branch as one parentless commit holding every PR folder, with `folder`
// replaced by the files in `stageDir` (or removed when stageDir is null). Squashing keeps the branch
// small: replaced videos are not kept in history. Retries when another run pushed in between.
export function publishFolder(root, { branch, folder, stageDir, message, remote = 'origin', attempts = 5 }) {
  const env = { ...process.env };
  env.GIT_AUTHOR_NAME ??= 'github-actions[bot]';
  env.GIT_AUTHOR_EMAIL ??= '41898282+github-actions[bot]@users.noreply.github.com';
  env.GIT_COMMITTER_NAME ??= env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL ??= env.GIT_AUTHOR_EMAIL;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const fetched = git(root, ['fetch', '-q', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    const current = fetched.status === 0 ? git(root, ['rev-parse', `refs/remotes/${remote}/${branch}`]).stdout.trim() : '';
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-'));
    const indexEnv = { ...env, GIT_INDEX_FILE: path.join(indexDir, 'index') };
    try {
      git(root, ['read-tree', ...(current ? [current] : ['--empty'])], { env: indexEnv, allowFail: false });
      git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', folder], { env: indexEnv, allowFail: false });
      for (const name of stageDir ? fs.readdirSync(stageDir).sort() : []) {
        const blob = git(root, ['hash-object', '-w', '--', path.join(stageDir, name)], { allowFail: false }).stdout.trim();
        git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${folder}/${name}`], { env: indexEnv, allowFail: false });
      }
      const tree = git(root, ['write-tree'], { env: indexEnv, allowFail: false }).stdout.trim();
      if (current && git(root, ['rev-parse', `${current}^{tree}`]).stdout.trim() === tree) return { pushed: false, commit: current };
      const commit = git(root, ['commit-tree', tree, '-m', message], { env, allowFail: false }).stdout.trim();
      const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${branch}:${current}`, remote, `${commit}:refs/heads/${branch}`]);
      if (push.status === 0) return { pushed: true, commit };
      log(`push to ${branch} failed (attempt ${attempt}/${attempts}): ${push.stderr.trim()}`);
    } finally {
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
  }
  throw new Error(`could not push ${branch} after ${attempts} attempts`);
}

export function readPrBody(root, pr) {
  const view = run('gh', ['pr', 'view', String(pr), '--json', 'body', '--jq', '.body'], { cwd: root });
  if (view.status !== 0) throw new Error(`gh pr view ${pr} failed: ${view.stderr.trim()}`);
  return view.stdout.replace(/\n$/, '');
}

// Writes `section` into the PR body between `markers` (default: the demo video section);
// a null section removes it.
export function writePrSection(root, pr, section, markers) {
  const current = readPrBody(root, pr);
  const body = section === null ? removeSection(current, markers) : upsertSection(current, section, markers);
  if (body === current) return;
  const edit = run('gh', ['pr', 'edit', String(pr), '--body-file', '-'], { cwd: root, input: body });
  if (edit.status !== 0) throw new Error(`gh pr edit ${pr} failed: ${edit.stderr.trim()}`);
}
