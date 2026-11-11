// Issue body format for board tickets (story, bug, epic, spike). The GitHub issue is the source of
// truth: its body carries the complete source Markdown verbatim between two markers, plus a hidden
// metadata block. See docs/ai-pipeline/board.md#issue-body-format.
//
//   <!-- board-ticket:v1
//   {"key":"PROMO-3","type":"story", ... ,"sourceHash":"<sha256>","assets":{...}}
//   -->
//   > header (generated: type, epic, blockers, how to edit)
//
//   <!-- board-ticket:source:begin -->
//   <the source Markdown, verbatim>
//   <!-- board-ticket:source:end -->
//
//   ## Mockups / ## Attachments (generated from the asset manifest, pinned to the asset commit)
//
// Round trip: parseBody(renderBody(t)).content reconstructs the source byte for byte. Normalisation:
// GitHub may store the body with CRLF line endings (web edits do); parseBody reads CRLF as LF, then
// restores the source's own line endings (`eol`) and final newline (`finalNewline`) from the metadata.
// Sources that cannot be carried that way (mixed line endings, a marker inside the text, or a body over
// the issue size limit) are "spilled": stored as an asset and linked, and the metadata says so.
import { createHash } from 'node:crypto';

export const SCHEMA = 1;
export const META_OPEN = '<!-- board-ticket:v1';
export const BEGIN = '<!-- board-ticket:source:begin -->';
export const END = '<!-- board-ticket:source:end -->';
// GitHub rejects issue bodies over 65,536 characters; keep a margin for the generated sections.
export const BODY_LIMIT = 65_536;
export const TYPES = ['story', 'bug', 'epic', 'spike'];

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;

// The line-ending style of a text: lf, crlf, or mixed (which cannot be restored from one flag).
export function eolOf(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (!crlf) return 'lf';
  return crlf === lf ? 'crlf' : 'mixed';
}

// Carries metadata JSON inside an HTML comment: `>` is escaped so `-->` can never close it early.
const encodeMeta = (meta) => JSON.stringify(meta, null, 0).replace(/>/g, '\\u003e');

export function blobUrl(repo, commit, assetPath, { raw = false } = {}) {
  const p = assetPath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/blob/${commit}/${p}${raw ? '?raw=true' : ''}`;
}

const TYPE_LABEL = { story: 'Story', bug: 'Bug', epic: 'Epic', spike: 'Research spike' };

function header(meta, links) {
  const parts = [`**${meta.key}**`, TYPE_LABEL[meta.type] ?? meta.type];
  const ref = (key) => (links?.[key] ? `#${links[key]}` : `\`${key}\``);
  if (meta.parent) parts.push(`part of ${ref(meta.parent)}`);
  if (meta.blockedBy?.length) parts.push(`blocked by ${meta.blockedBy.map(ref).join(', ')}`);
  const lines = [`> ${parts.join(' · ')}`, '>'];
  lines.push(
    meta.content === 'inline'
      ? '> The text between the `board-ticket:source` markers below is the source of truth for the pipeline (`board fetch` reads it back verbatim). Edit it there; everything outside the markers is generated.'
      : `> The full source is too large for an issue body or cannot be stored inline; it is the asset [\`${meta.content.spilled}\`](${blobUrl(meta.assets.repo, meta.assets.commit, meta.content.spilled)}) (sha256 \`${meta.sourceHash.slice(0, 12)}\`).`,
  );
  return lines.join('\n');
}

// The generated asset sections: images inline, other files linked, every URL pinned to the asset commit.
export function renderAssets(meta) {
  const files = meta.assets?.files ?? [];
  if (!files.length) return '';
  const { repo, commit } = meta.assets;
  const out = [];
  const groups = [
    ['mockup', '## Mockups'],
    ['file', '## Attachments'],
  ];
  for (const [kind, title] of groups) {
    const list = files.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push(title, '');
    let folder = null;
    for (const f of list) {
      const dir = f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : '';
      if (dir !== folder) {
        if (dir) out.push(`### ${dir}`, '');
        folder = dir;
      }
      const base = f.name.slice(f.name.lastIndexOf('/') + 1);
      if (IMAGE.test(base)) out.push(`![${base}](${blobUrl(repo, commit, f.path, { raw: true })})`, '');
      else out.push(`- [\`${base}\`](${blobUrl(repo, commit, f.path)})`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// Builds the metadata for a source text. `ticket`: { key, type, title, slug, source, parent, blockedBy }.
export function metaFor(ticket, text, { assets = null } = {}) {
  if (!TYPES.includes(ticket.type)) throw new Error(`unknown ticket type "${ticket.type}"`);
  const eol = eolOf(text);
  const lf = text.replace(/\r\n/g, '\n');
  return {
    schema: SCHEMA,
    key: ticket.key,
    type: ticket.type,
    title: ticket.title ?? null,
    slug: ticket.slug ?? null,
    source: ticket.source ?? null,
    parent: ticket.parent ?? null,
    blockedBy: ticket.blockedBy ?? [],
    sourceHash: sha256(Buffer.from(text, 'utf8')),
    eol,
    finalNewline: lf.endsWith('\n'),
    content: 'inline',
    assets: assets ?? { repo: null, branch: null, commit: null, files: [] },
  };
}

// Whether a source can be carried inline (exactly restorable from the body).
export function inlineable(text) {
  return eolOf(text) !== 'mixed' && !text.includes(BEGIN) && !text.includes(END) && !text.includes(META_OPEN);
}

// Renders an issue body. `spillPath`: the asset path to use when the source must be spilled (the caller
// uploads the source there; renderBody only decides). Returns { body, meta, spilled }.
export function renderBody(ticket, text, { assets = null, links = null, footer = '', limit = BODY_LIMIT, spillPath = null } = {}) {
  const meta = metaFor(ticket, text, { assets });
  const build = (m) => {
    const parts = [`${META_OPEN}\n${encodeMeta(m)}\n-->`, header(m, links), ''];
    if (m.content === 'inline') {
      let lf = text.replace(/\r\n/g, '\n');
      if (m.finalNewline) lf = lf.slice(0, -1);
      parts.push(BEGIN, lf, END);
    } else {
      const preview = text.replace(/\r\n/g, '\n').slice(0, 4000);
      parts.push('<details><summary>Preview (first 4,000 characters)</summary>', '', '````markdown', preview.replace(/````/g, '` ` ` `'), '````', '', '</details>');
    }
    const assetsSection = renderAssets(m);
    if (assetsSection) parts.push('', '---', '', assetsSection);
    if (footer) parts.push('', '---', '', footer);
    return `${parts.join('\n')}\n`;
  };
  let body = inlineable(text) ? build(meta) : null;
  if (body && body.length <= limit) return { body, meta, spilled: false };
  const path = spillPath ?? `files/${ticket.key}/${ticket.source ? ticket.source.split('/').pop() : 'source.md'}`;
  const spilled = { ...meta, content: { spilled: path } };
  body = build(spilled);
  if (body.length > limit) {
    // The generated asset list is what is left to cut: the manifest in the metadata stays complete.
    const lean = build({ ...spilled, assets: { ...spilled.assets, files: [] } });
    body = lean.replace(/\n$/, `\n\n_${spilled.assets.files.length} asset(s) not listed (body size limit); see the metadata block._\n`);
  }
  return { body, meta: spilled, spilled: true };
}

// Parses an issue body. Returns { meta, content } where content is the reconstructed source (exact
// bytes as a string) or null when it was spilled (fetch the `meta.content.spilled` asset), plus
// `edited` when the inline text no longer matches the recorded hash (someone edited the issue).
// Bodies without a metadata block (written before the migration) return { legacy: true, ... }.
export function parseBody(rawBody) {
  const body = String(rawBody ?? '').replace(/\r\n/g, '\n');
  const start = body.indexOf(`${META_OPEN}\n`);
  if (start < 0) return { meta: null, content: null, legacy: true };
  const close = body.indexOf('\n-->', start);
  if (close < 0) throw new Error('board-ticket metadata block is not closed');
  const meta = JSON.parse(body.slice(start + META_OPEN.length + 1, close));
  if (meta.content !== 'inline') return { meta, content: null, spilled: meta.content?.spilled ?? null, edited: false };
  const b = body.indexOf(`${BEGIN}\n`, close);
  const e = body.lastIndexOf(`\n${END}`);
  if (b < 0 || e < b) throw new Error(`${meta.key}: the board-ticket:source markers are missing; restore them or re-run board migrate --apply`);
  let content = body.slice(b + BEGIN.length + 1, e) + (meta.finalNewline ? '\n' : '');
  if (b + BEGIN.length + 1 > e) content = meta.finalNewline ? '\n' : '';
  if (meta.eol === 'crlf') content = content.replace(/\n/g, '\r\n');
  const edited = sha256(Buffer.from(content, 'utf8')) !== meta.sourceHash;
  return { meta, content, spilled: null, edited };
}

// Best-effort reconstruction of a pre-migration body (story text minus its heading, after the
// generated preamble). Used only when no metadata block exists yet.
export function parseLegacyBody(rawBody, title) {
  const body = String(rawBody ?? '').replace(/\r\n/g, '\n');
  const marker = body.indexOf('\n---\n\n', body.search(/Assign this issue|The stories of this epic/));
  let text = marker >= 0 ? body.slice(marker + 5) : body;
  text = text.replace(/^## Mockups\n[\s\S]*?\n---\n\n/, '');
  return `# ${title}\n\n${text.trimEnd()}\n`;
}
