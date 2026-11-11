import fs from 'node:fs';
import path from 'node:path';
import { fsReader } from '../../pipeline/lib/git.mjs';
import { casePrefix } from '../../pipeline/lib/stories.mjs';
import { log, readJson, run, tail } from '../../pipeline/lib/util.mjs';
import { SECTION_END, SECTION_START } from '../../pr-video/lib/pr-video.mjs';

// ---------------------------------------------------------------------------------------------
// UI stories: feature video
// ---------------------------------------------------------------------------------------------

// The PR demo video workflow (.github/workflows/pr-demo-video.yml, scripts/pr-video) records the e2e
// specs a frontend PR changes and keeps a "Demo video" section between markers in the PR body. That
// section is the story's feature video: the ticket and its epic link the same recording. The workflow
// runs after the PR opens, so this returns null until it has published; `board sync` fills it in later.
// Returns { markdown, url } (url: the first full video link) or null.
export function featureVideo(config, story, { pr, readPrBody = defaultPrBody } = {}) {
  if (!pr) return null;
  let body;
  try {
    body = readPrBody(config, pr);
  } catch (error) {
    log(`${story?.key ?? pr}: could not read the PR body for its demo video: ${error.message.split('\n')[0]}`);
    return null;
  }
  return videoFromPrBody(body);
}

export function videoFromPrBody(body) {
  const start = (body ?? '').indexOf(SECTION_START);
  const end = (body ?? '').indexOf(SECTION_END);
  if (start < 0 || end < start) return null;
  const section = body
    .slice(start + SECTION_START.length, end)
    .split('\n')
    .filter((l) => !/^\s*##\s+Demo video\s*$/i.test(l) && !/^<sub>Updated by/.test(l))
    .join('\n')
    .trim();
  const url = /\[Full video[^\]]*\]\((https:\/\/[^)\s]+)\)/.exec(section)?.[1] ?? null;
  // A note without a recording (for example "no frontend changes") is not a video.
  if (!url) return null;
  return { markdown: section, url };
}

function defaultPrBody(config, pr) {
  const r = run('gh', ['pr', 'view', String(pr), '--json', 'body', '-q', '.body'], { cwd: config.root });
  if (r.status !== 0) throw new Error(r.stderr.trim() || `gh pr view ${pr} failed`);
  return r.stdout;
}

// ---------------------------------------------------------------------------------------------
// API stories: the requests and responses of the story's verified Playwright tests
// ---------------------------------------------------------------------------------------------

const SECRET_KEY = /token|password|secret|authorization|cookie|client_assertion/i;
const TEXT_MIME = /json|text|xml|x-www-form-urlencoded|javascript|problem/i;

export function redact(body, mimeType = '') {
  if (!body) return body;
  if (/x-www-form-urlencoded/i.test(mimeType)) {
    const params = new URLSearchParams(body);
    for (const key of [...params.keys()]) if (SECRET_KEY.test(key)) params.set(key, '***');
    return decodeURIComponent(params.toString());
  }
  try {
    const scrub = (v) => (Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '***' : scrub(x)])) : v);
    return JSON.stringify(scrub(JSON.parse(body)), null, 2);
  } catch {
    return body;
  }
}

// API calls (`request` fixture) recorded in a trace's *.network files. Browser traffic is left out.
export function parseNetwork(text, readResource) {
  const exchanges = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const s = event.type === 'resource-snapshot' ? event.snapshot : null;
    if (!s?._apiRequest) continue;
    const body = (part, mimeType) => {
      if (!part) return '';
      const raw = part._sha1 ? readResource(part._sha1) : part.text ?? '';
      if (!raw) return '';
      return TEXT_MIME.test(mimeType ?? '') ? redact(raw, mimeType) : `<${mimeType || 'binary'}, ${raw.length} bytes>`;
    };
    exchanges.push({
      method: s.request.method,
      url: s.request.url,
      status: s.response.status,
      statusText: s.response.statusText,
      requestBody: body(s.request.postData, s.request.postData?.mimeType),
      requestMime: s.request.postData?.mimeType ?? '',
      responseBody: body(s.response.content, s.response.content?.mimeType),
      responseMime: s.response.content?.mimeType ?? '',
    });
  }
  return exchanges;
}

// Test title and trace path of every test in a Playwright JSON report (last attempt wins on retries).
export function tracesFromReport(report) {
  const byTitle = new Map();
  const visit = (suite, titles) => {
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title].filter(Boolean));
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const result = (t.results ?? []).at(-1);
        const trace = result?.attachments?.find((a) => a.name === 'trace' && a.path);
        if (trace) byTitle.set(`${t.projectName ?? ''}\0${spec.title}`, { title: spec.title, status: result.status, trace: trace.path });
      }
    }
  };
  for (const suite of report?.suites ?? []) visit(suite, []);
  return [...byTitle.values()];
}

const fence = (text, mime) => {
  const lang = /json/i.test(mime) ? 'json' : /xml|html/i.test(mime) ? 'xml' : '';
  return `\`\`\`${lang}\n${text.replace(/```/g, '`\u200b``')}\n\`\`\``;
};
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters)` : text);
const shortUrl = (url) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

export function renderEvidence(key, tests, { maxExchanges = 60, maxBodyChars = 1500, maxChars = 60000 } = {}) {
  const total = tests.reduce((n, t) => n + t.exchanges.length, 0);
  const failed = tests.filter((t) => !['passed', 'skipped'].includes(t.status));
  const head = [`### API evidence for ${key}`, '', `${total} request(s) recorded from ${tests.length} verified test(s) against the test stack.${failed.length ? ` **${failed.length} test(s) did not pass on the evidence run:** ${failed.map((t) => t.title).join(', ')}.` : ''} Secrets in bodies are redacted.`, ''];
  const sections = [];
  let shown = 0;
  let size = head.join('\n').length;
  for (const t of tests) {
    if (!t.exchanges.length) continue;
    const parts = [`<details><summary><b>${t.title}</b> (${t.status}, ${t.exchanges.length} request(s))</summary>`, ''];
    for (const x of t.exchanges) {
      if (shown >= maxExchanges) break;
      const block = [`**${x.method}** \`${shortUrl(x.url)}\` → **${x.status} ${x.statusText ?? ''}**`.trimEnd(), ''];
      if (x.requestBody) block.push('Request:', '', fence(clip(x.requestBody, maxBodyChars), x.requestMime), '');
      block.push('Response:', '', x.responseBody ? fence(clip(x.responseBody, maxBodyChars), x.responseMime) : '_(empty)_', '');
      const text = block.join('\n');
      if (size + text.length > maxChars - 500) break;
      parts.push(text);
      size += text.length;
      shown++;
    }
    parts.push('</details>', '');
    sections.push(parts.join('\n'));
    if (shown >= maxExchanges || size > maxChars - 500) break;
  }
  if (shown < total) sections.push(`_${total - shown} more request(s) not shown; the full log is in \`.agent-state/evidence/${key}/api-evidence.md\` on the machine that ran the pipeline._`);
  return [...head, ...sections].join('\n');
}

// Re-runs the story's Playwright tests with tracing on and turns their API calls into Markdown.
// Returns null when the story has no Playwright tests (for example .NET-only tests).
export function captureApiEvidence(config, story) {
  const settings = config.board.evidence;
  const reader = fsReader(config.root);
  const prefix = casePrefix(story.key);
  const roots = config.testRoots ?? ['e2e', 'tests', 'testing/scenarios'];
  const files = roots.flatMap((r) => reader.walk(r)).filter((f) => f.endsWith('.ts') && reader.read(f)?.includes(prefix));
  if (!files.length) return null;

  const outDir = path.join(config.root, config.stateDir, 'evidence', story.key);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, 'report.json');
  const [cmd, ...template] = settings.playwright;
  const args = template.flatMap((a) => (a === '{files}' ? files : [a.replace('{casePrefix}', prefix).replace('{output}', path.join(outDir, 'results'))]));
  log(`${story.key}: capturing API evidence: ${cmd} ${args.join(' ')}`);
  const result = run(cmd, args, { cwd: config.root, timeoutSec: settings.timeoutSec, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile } });
  const report = readJson(reportFile, null);
  if (!report) throw new Error(`the evidence run produced no report (exit ${result.status}): ${tail(result.stderr || result.stdout, 400)}`);

  const tests = tracesFromReport(report).filter((t) => t.title.includes(prefix)).map((t) => {
    const trace = path.isAbsolute(t.trace) ? t.trace : path.join(config.root, t.trace);
    const entries = run('unzip', ['-Z1', trace]).stdout.split('\n').filter((e) => e.endsWith('.network'));
    const network = entries.map((e) => run('unzip', ['-p', trace, e]).stdout).join('\n');
    return { ...t, exchanges: parseNetwork(network, (sha1) => run('unzip', ['-p', trace, `resources/${sha1}`]).stdout) };
  });
  const full = renderEvidence(story.key, tests, { maxExchanges: Infinity, maxBodyChars: Infinity, maxChars: Infinity });
  fs.writeFileSync(path.join(outDir, 'api-evidence.md'), full);
  return renderEvidence(story.key, tests, { maxExchanges: settings.maxExchanges, maxBodyChars: settings.maxBodyChars, maxChars: settings.maxCommentChars });
}
