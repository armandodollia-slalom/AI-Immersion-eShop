// API summary for backend pull requests: the HTTP endpoints a PR adds, changes or removes (from the
// minimal-API route mappings in src/), documented from the test stack's OpenAPI documents and illustrated
// with the real calls its e2e specs made (E2E_API_LOG=1, e2e/fixtures.ts). Rendered as the PR's
// "API changes" section. See docs/ai-pipeline/pr-demo-video.md.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';

export const API_MARKERS = { start: '<!-- pr-api-summary:start -->', end: '<!-- pr-api-summary:end -->' };
// OpenAPI documents the test stack serves (testing/teststack.json); Basket.API is gRPC and has none.
export const DEFAULT_OPENAPI = [
  'http://localhost:18082/openapi/v1.json',
  'http://localhost:18082/openapi/v2.json',
  'http://localhost:18084/openapi/v1.json',
  'http://localhost:18085/openapi/v1.json',
];
// Frontend: the web and client UI projects, plus views, pages and static assets anywhere in src/
// (such as the Identity.API login pages). Backend: the rest of src/, except the AppHost and
// ServiceDefaults wiring. Files outside src/ (tests, e2e specs, docs, CI) count as neither.
const FRONTEND_PROJECT = /^src\/(WebApp|WebAppComponents|WebhookClient|HybridApp|ClientApp)\//;
const FRONTEND_FILE = /^src\/.+(\.(razor|cshtml|css|scss|less|js|ts|html)$|\/(Views|Pages|wwwroot)\/)/;
const NEUTRAL_PROJECT = /^src\/(eShop\.AppHost|eShop\.ServiceDefaults)\//;
const SECTION_BUDGET = 40000;
const EXAMPLES_PER_ENDPOINT = 3;
const EXAMPLE_BODY_LIMIT = 1500;

const MAP_CALL = /(\w+)\s*\.\s*Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]*)"\s*(?:,\s*(\w+)\s*\))?/g;
const HAS_MAP = /\.Map(Get|Post|Put|Patch|Delete)\s*\(/;
const GROUP = /(\w+)\s*=\s*[\w.]*?\.MapGroup\s*\(\s*"([^"]*)"\s*\)([^;]*)/g;

// `{id:int}` -> `{id}`, `{brandId:int?}` -> `{brandId?}`
export const normalizeRoute = (route) => route.replace(/\{(\w+)(?::[^{}]*?)?(\?)?\}/g, '{$1$2}');

function joinRoute(prefix, route) {
  const parts = [prefix, route].flatMap((p) => p.split('/')).filter(Boolean);
  return normalizeRoute(`/${parts.join('/')}`);
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

// Endpoints mapped in one C# file: method, route (with its MapGroup prefix), API versions, and the
// source lines that implement it (the Map call, an inline lambda up to the next Map call, or the
// named handler method), used to tell whether a diff touched it.
export function parseEndpoints(source) {
  const groups = new Map();
  for (const m of source.matchAll(GROUP)) {
    const versions = [...m[3].matchAll(/HasApiVersion\s*\(\s*([\d.]+)(?:\s*,\s*(\d+))?\s*\)/g)]
      .map((v) => (v[2] !== undefined ? `${v[1]}.${v[2]}` : v[1].includes('.') ? v[1] : `${v[1]}.0`));
    groups.set(m[1], { prefix: m[2], versions });
  }
  const lines = source.split('\n');
  const calls = [...source.matchAll(MAP_CALL)].map((m) => ({ m, line: lineOf(source, m.index) }));
  const endpoints = new Map();
  calls.forEach(({ m, line }, i) => {
    const [, receiver, verb, route, handler] = m;
    const group = groups.get(receiver) ?? { prefix: '', versions: [] };
    const method = verb.toUpperCase();
    const template = joinRoute(group.prefix, route);
    const ranges = [[line, (calls[i + 1]?.line ?? lines.length + 1) - 1]];
    if (handler) {
      const def = lines.findIndex((l, n) => n + 1 !== line && new RegExp(`\\b${handler}\\s*(<[^>]*>)?\\s*\\(`).test(l) && /\b(static|public|private|internal|async)\b/.test(l));
      if (def !== -1) {
        const next = lines.findIndex((l, n) => n > def && /^\s*(public|private|internal)\s+static\b/.test(l));
        ranges.push([def + 1, next === -1 ? lines.length : next]);
      }
    }
    const key = `${method} ${template}`;
    const existing = endpoints.get(key);
    if (existing) {
      existing.versions = [...new Set([...existing.versions, ...group.versions])].sort();
      existing.ranges.push(...ranges);
    } else {
      endpoints.set(key, { method, route: template, versions: [...group.versions].sort(), line, ranges });
    }
  });
  return [...endpoints.values()];
}

const serviceOf = (file) => file.split('/')[1] ?? file;

function changedLines(root, mergeBase, file) {
  const diff = git(root, ['diff', '-U0', mergeBase, 'HEAD', '--', file]).stdout;
  const lines = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion (count 0) touches the line it was removed after.
    for (let n = start; n < start + Math.max(count, 1); n++) lines.push(n);
  }
  return lines;
}

function mergeBaseOf(root, base) {
  return git(root, ['merge-base', base, 'HEAD'], { allowFail: false }).stdout.trim();
}

function changedFiles(root, mergeBase) {
  return git(root, ['diff', '--name-status', '--no-renames', mergeBase, 'HEAD'], { allowFail: false }).stdout
    .split('\n')
    .map((l) => l.trim().split('\t'))
    .filter(([status, file]) => status && file)
    .map(([status, file]) => ({ status: status[0], file }));
}

// Whether the changed files touch the frontend, the backend, or both. A PR gets a demo video only
// when it changes the frontend, and an API summary only when it changes the backend and not the frontend.
export function classifyFiles(files) {
  const frontend = files.some((f) => FRONTEND_PROJECT.test(f) || FRONTEND_FILE.test(f));
  const backend = files.some((f) => f.startsWith('src/') && !FRONTEND_PROJECT.test(f) && !FRONTEND_FILE.test(f) && !NEUTRAL_PROJECT.test(f));
  return { frontend, backend, video: frontend, api: backend && !frontend };
}

export function changeScope(root, base) {
  return classifyFiles(changedFiles(root, mergeBaseOf(root, base)).map(({ file }) => file));
}

// Endpoints added, modified or removed since the merge base with `base`.
export function changedEndpoints(root, base) {
  const mergeBase = mergeBaseOf(root, base);
  const result = [];
  for (const { status, file } of changedFiles(root, mergeBase)) {
    if (!/^src\/.+\.cs$/.test(file) || /(^|\/)tests?\//i.test(file)) continue;
    const before = status === 'A' ? '' : git(root, ['show', `${mergeBase}:${file}`]).stdout;
    const after = status === 'D' || !fs.existsSync(path.join(root, file)) ? '' : fs.readFileSync(path.join(root, file), 'utf8');
    if (!HAS_MAP.test(before) && !HAS_MAP.test(after)) continue;
    const old = new Map(parseEndpoints(before).map((e) => [`${e.method} ${e.route}`, e]));
    const touched = status === 'D' ? [] : changedLines(root, mergeBase, file);
    for (const e of parseEndpoints(after)) {
      const key = `${e.method} ${e.route}`;
      const was = old.get(key);
      old.delete(key);
      const modified = was && (touched.some((n) => e.ranges.some(([a, b]) => n >= a && n <= b)) || was.versions.join() !== e.versions.join());
      if (!was || modified) result.push({ change: was ? 'modified' : 'added', method: e.method, route: e.route, versions: e.versions, service: serviceOf(file), file, line: e.line });
    }
    for (const e of old.values()) result.push({ change: 'removed', method: e.method, route: e.route, versions: e.versions, service: serviceOf(file), file, line: e.line });
  }
  return result;
}

// Every endpoint mapped in src/ at HEAD, to name the route templates the recorded calls hit.
export function allEndpoints(root) {
  const files = git(root, ['ls-files', '--', 'src/*.cs'], { allowFail: false }).stdout.split('\n').filter(Boolean);
  const out = [];
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, 'utf8');
    if (!HAS_MAP.test(source)) continue;
    for (const e of parseEndpoints(source)) out.push({ method: e.method, route: e.route, versions: e.versions, service: serviceOf(file), file, line: e.line });
  }
  return out;
}

function routeRegex(route) {
  const pattern = route
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const optional = /^\{\w+\?\}$/.test(seg);
      const body = /^\{\w+\??\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return optional ? `(?:/${body})?` : `/${body}`;
    })
    .join('');
  return new RegExp(`^${pattern || ''}/?$`, 'i');
}

// Literal segments win over parameters when several templates match a path.
const specificity = (route) => route.split('/').filter((s) => s && !s.startsWith('{')).length;

export function matchEndpoint(endpoints, method, url) {
  const pathname = new URL(url).pathname;
  return endpoints
    .filter((e) => e.method === method && routeRegex(e.route).test(pathname))
    .sort((a, b) => specificity(b.route) - specificity(a.route))[0];
}

// Recorded calls from artifacts/e2e-videos/manifest.json (last attempt of each test).
export function recordedExchanges(manifest) {
  const latest = new Map();
  for (const t of manifest?.tests ?? []) {
    const key = [t.project, t.file, ...t.titlePath].join('\u0000');
    if (!latest.has(key) || latest.get(key).retry <= t.retry) latest.set(key, t);
  }
  return [...latest.values()].flatMap((t) => (t.api ?? []).map((x) => ({ ...x, test: t.titlePath.slice(2).join(' › ') || t.title, file: t.file })));
}

export async function loadOpenApi(urls, fetchImpl = globalThis.fetch) {
  const docs = [];
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
      if (response.ok) docs.push({ url, doc: await response.json() });
    } catch {
      // A service that is down or has no OpenAPI document is simply not documented.
    }
  }
  return docs;
}

const templateKey = (route) => route.toLowerCase().replace(/\{\w+\??\}/g, '{}').replace(/\/+$/, '') || '/';

function schemaName(schema) {
  if (!schema) return 'any';
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'array') return `${schemaName(schema.items)}[]`;
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null').join(' | ') : schema.type;
  return [type ?? 'object', schema.format ? `(${schema.format})` : ''].join('');
}

function resolve(schema, doc) {
  const name = schema?.$ref?.split('/').pop();
  return name ? doc.components?.schemas?.[name] : schema;
}

// OpenAPI operation details for one endpoint, merged across the documents (API versions) that have it.
export function describeOperation(docs, method, route) {
  const found = [];
  for (const { url, doc } of docs) {
    const entry = Object.entries(doc.paths ?? {}).find(([p]) => templateKey(p) === templateKey(route));
    const op = entry?.[1]?.[method.toLowerCase()];
    if (!op) continue;
    const params = [...(entry[1].parameters ?? []), ...(op.parameters ?? [])].map((p) => {
      const param = p.$ref ? doc.components?.parameters?.[p.$ref.split('/').pop()] ?? p : p;
      return { name: param.name, in: param.in, required: !!param.required, type: schemaName(param.schema) };
    });
    const content = op.requestBody?.content ?? {};
    const [contentType, media] = Object.entries(content)[0] ?? [];
    const bodySchema = media?.schema;
    const fields = Object.entries(resolve(bodySchema, doc)?.properties ?? {}).map(([name, s]) => `${name}: ${schemaName(s)}`);
    const responses = Object.entries(op.responses ?? {}).map(([code, r]) => {
      const schema = Object.values(r.content ?? {})[0]?.schema;
      return { code, description: r.description ?? '', type: schema ? schemaName(schema) : null };
    });
    found.push({
      version: doc.info?.version ?? path.basename(new URL(url).pathname, '.json'),
      summary: op.summary ?? op.description ?? '',
      params,
      request: contentType ? { contentType, type: schemaName(bodySchema), required: !!op.requestBody?.required, fields } : null,
      responses,
    });
  }
  if (!found.length) return null;
  const latest = found[found.length - 1];
  return { ...latest, versions: found.map((f) => f.version) };
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const clip = (text = '', limit = EXAMPLE_BODY_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text);
const CHANGE_LABEL = { added: '🆕 Added', modified: '✏️ Changed', removed: '🗑️ Removed', exercised: '🧪 Exercised' };

function renderExample(x) {
  const url = new URL(x.url);
  const request = [`${x.method} ${url.pathname}${url.search}`];
  for (const [k, v] of Object.entries(x.requestHeaders ?? {})) request.push(`${k}: ${v}`);
  if (x.requestBody) request.push('', clip(x.requestBody));
  const lang = /json/i.test(x.responseContentType ?? '') ? 'json' : 'text';
  return [
    `<details><summary>Example: <code>${x.status}</code> · ${cell(x.test)}</summary>`,
    '',
    '**Request**',
    '',
    '```http',
    ...request,
    '```',
    '',
    `**Response** \`${x.status}\`${x.responseContentType ? ` \`${x.responseContentType}\`` : ''}`,
    '',
    ...(x.responseBody ? [`\`\`\`${lang}`, clip(x.responseBody), '```'] : ['_(empty body)_']),
    '',
    '</details>',
  ];
}

function renderEndpoint(e, withExamples) {
  const out = ['', `### \`${e.method} ${e.route}\``, ''];
  const where = e.change === 'exercised' && !e.file ? `by \`${e.calls[0]?.file ?? 'e2e specs'}\`` : `in \`${e.file}${e.line ? `:${e.line}` : ''}\``;
  const meta = [`${CHANGE_LABEL[e.change]} ${where}`];
  if (e.versions?.length) meta.push(`API versions ${e.versions.join(', ')}`);
  out.push(meta.join(' · '));
  const op = e.operation;
  if (op) {
    if (op.summary) out.push('', op.summary);
    if (op.params.length) out.push('', `**Parameters:** ${op.params.map((p) => `\`${p.name}\` (${p.in}, ${p.type}${p.required ? ', required' : ''})`).join(', ')}`);
    if (op.request) {
      out.push('', `**Request body:** \`${op.request.contentType}\` \`${op.request.type}\`${op.request.required ? ' (required)' : ''}`);
      if (op.request.fields.length) out.push(`<br>Fields: ${op.request.fields.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (op.responses.length) out.push('', `**Responses:** ${op.responses.map((r) => `\`${r.code}\`${r.type ? ` \`${r.type}\`` : ''}${r.description ? ` ${r.description}` : ''}`).join(' · ')}`);
  } else if (e.change !== 'removed') {
    out.push('', '_Not in the test stack\'s OpenAPI documents._');
  }
  if (withExamples && e.examples.length) out.push('', ...e.examples.flatMap(renderExample));
  return out.join('\n');
}

// Groups the recorded calls by endpoint, attaches OpenAPI details, and renders the section.
// Returns null when the PR neither changes an endpoint nor records a call.
export function buildApiSummary({ changed = [], known = [], exchanges = [], docs = [] }) {
  const endpoints = new Map();
  for (const e of changed) endpoints.set(`${e.method} ${e.route}`, { ...e, calls: [] });
  const candidates = [...changed.filter((e) => e.change !== 'removed'), ...known];
  for (const x of exchanges) {
    const match = matchEndpoint(candidates, x.method, x.url);
    const route = match?.route ?? new URL(x.url).pathname;
    const key = `${x.method} ${route}`;
    if (!endpoints.has(key)) endpoints.set(key, { change: 'exercised', method: x.method, route, versions: match?.versions ?? [], service: match?.service ?? new URL(x.url).host, file: match?.file ?? '', line: match?.line, calls: [] });
    endpoints.get(key).calls.push(x);
  }
  const order = { added: 0, modified: 1, removed: 2, exercised: 3 };
  return [...endpoints.values()]
    .sort((a, b) => order[a.change] - order[b.change] || a.route.localeCompare(b.route) || a.method.localeCompare(b.method))
    .map((e) => {
      const byStatus = new Map();
      for (const x of e.calls) if (!byStatus.has(x.status)) byStatus.set(x.status, x);
      const examples = [...byStatus.values()].sort((a, b) => a.status - b.status).slice(0, EXAMPLES_PER_ENDPOINT);
      return { ...e, operation: e.change === 'removed' ? null : describeOperation(docs, e.method, e.route), examples };
    });
}

export function renderApiSection({ endpoints, headSha, runUrl, specs = [] }) {
  if (!endpoints.length) return null;
  const source = `${headSha ? `commit ${headSha.slice(0, 7)}` : 'this PR'}${runUrl ? `, [workflow run](${runUrl})` : ''}`;
  const lines = [
    '## API changes',
    '',
    `HTTP endpoints this PR adds, changes or removes (from the route mappings in \`src/\`), documented from the test stack's OpenAPI and illustrated with the calls ${specs.length ? `its e2e specs (${specs.map((s) => `\`${s}\``).join(', ')})` : 'its e2e specs'} made (${source}).`,
    '',
    '| Change | Method | Endpoint | Service | Request | Responses | Recorded calls |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of endpoints) {
    const request = e.operation?.request ? `\`${e.operation.request.type}\`` : '';
    const responses = e.operation?.responses.map((r) => r.code).join(', ') ?? '';
    const statuses = [...new Set(e.calls.map((x) => x.status))].sort((a, b) => a - b);
    const calls = e.calls.length ? `${e.calls.length} (${statuses.join(', ')})` : '';
    lines.push(`| ${CHANGE_LABEL[e.change]} | \`${e.method}\` | \`${cell(e.route)}\` | ${cell(e.service)} | ${request} | ${responses} | ${calls} |`);
  }
  const footer = ['', '<sub>Updated by `.github/workflows/pr-demo-video.yml` on every push; edits inside this section are overwritten. Secrets in recorded calls are redacted and long bodies truncated.</sub>'];
  let text = lines.join('\n');
  const detailed = endpoints.filter((e) => e.change !== 'removed');
  for (const [i, e] of detailed.entries()) {
    const full = renderEndpoint(e, true);
    const brief = full.length + text.length > SECTION_BUDGET ? renderEndpoint(e, false) : full;
    if (brief.length + text.length > SECTION_BUDGET) {
      text += `\n\n_${detailed.length - i} more endpoint(s) left out to fit the PR description; see the workflow run's artifact._`;
      break;
    }
    text += `\n${brief}`;
  }
  return `${text}\n${footer.join('\n')}`;
}
