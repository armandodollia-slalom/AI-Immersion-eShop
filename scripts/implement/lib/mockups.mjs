// A story's mockups for the builders and the UI verifier: which files they are (the story's own, and the
// epic's when the epic was handed to the run), and PNG renders of every mockup screen and state, so the
// pair-ui-verifier can put the running app next to the design every round. See
// docs/ai-pipeline/implement.md#ui-verification.
//
// Mockups are Design canvas files (`.dc.html`): a template inside <x-dc> with {{expressions}},
// <sc-if value> and <sc-for list as> blocks, and a <script type="text/x-dc" data-dc-script> holding a
// `class Component extends DCLogic` whose renderVals() returns the template's values from this.props and
// this.state. data-props declares the props (with defaults; `section: "State"` marks a state switch) and
// the preview size. The canvas runtime (support.js) is not shipped with the files, so the renderer brings
// a small one of its own. States are the default plus each boolean or enumerated prop and each boolean
// initial state flipped. Any other HTML file is rendered as a plain full page; images are used as they are.
/* global window, document, Image -- used inside page callbacks, which run in the browser */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handedSources } from '../../pipeline/lib/story-guard.mjs';

export const RENDERER_VERSION = 1;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const SCREEN = /\.html?$/i;
const DEFAULT_SIZE = { width: 1440, height: 1024 };

function walk(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

// The mockups the builders of a story get: its own (the `mockups/` folder next to its story.md) and, when
// the story's epic was handed to the run (PIPELINE_STORY_SOURCES), the epic's. Absolute paths.
export function storyMockups(config, storyFile, env = process.env) {
  const dir = path.dirname(storyFile);
  const key = path.basename(dir);
  const groups = [];
  const own = walk(path.join(dir, 'mockups'));
  if (own.length) groups.push({ key, source: 'story', dir: path.join(dir, 'mockups'), files: own });
  let epic = null;
  try {
    epic = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).parent ?? null;
  } catch {
    // a story without metadata has no epic
  }
  if (epic) {
    const { keys, dirs } = handedSources(config, env);
    const sources = (env.PIPELINE_STORY_SOURCES ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(config.root, p));
    const candidates = [...sources.filter((p) => path.basename(p) === epic), ...(keys.has(epic) ? [path.join(path.dirname(dir), epic)] : []), ...dirs.filter((p) => path.basename(p) === epic)];
    const epicDir = candidates.map((p) => path.join(p, 'mockups')).find((p) => fs.existsSync(p));
    if (epicDir) groups.push({ key: epic, source: 'epic', dir: epicDir, files: walk(epicDir) });
  }
  return groups;
}

export const mockupFilesOf = (groups) => groups.flatMap((g) => g.files);
export const hasMockups = (groups) => groups.some((g) => g.files.length);

// The mockup list for an agent's task: one line per file, grouped by ticket.
export function formatMockups(groups) {
  return groups
    .filter((g) => g.files.length)
    .map((g) => [`- ${g.source === 'epic' ? `Epic ${g.key} (the journey across its stories)` : `Story ${g.key}`}:`, ...g.files.map((f) => `  - ${f}`)].join('\n'))
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Design canvas parsing (pure)
// ---------------------------------------------------------------------------------------------

export const isDesignCanvas = (html) => /<x-dc[\s>]/i.test(html) && /data-dc-script/i.test(html);

export function dcTemplate(html) {
  const start = html.search(/<x-dc[\s>]/i);
  const open = html.indexOf('>', start) + 1;
  const end = html.lastIndexOf('</x-dc>');
  if (start < 0 || end < open) return '';
  // Unknown elements inside tables are moved out by the HTML parser; <template> is not, so the blocks
  // become templates before the page parses them.
  return html
    .slice(open, end)
    .replace(/<sc-(if|for)\b/gi, '<template data-sc="$1"')
    .replace(/<\/sc-(?:if|for)\s*>/gi, '</template>');
}

export function dcProps(html) {
  const m = /<script[^>]*data-dc-script[^>]*data-props='([^']*)'/i.exec(html) ?? /<script[^>]*data-props='([^']*)'[^>]*data-dc-script/i.exec(html);
  if (!m) return {};
  try {
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  } catch {
    return {};
  }
}

// Screen size: the canvas's own preview size, else its artboard in canvas.json, else 1440x1024.
export function screenSize(html, board = null) {
  const preview = dcProps(html).$preview;
  const width = Number(preview?.width ?? board?.w) || DEFAULT_SIZE.width;
  const height = Number(preview?.height ?? board?.h) || DEFAULT_SIZE.height;
  return { width, height };
}

// The states to render: default, each boolean prop flipped, each other option of an enumerated prop, and
// each boolean initial state flipped (from what the page reported after the default render).
export function dcVariants({ props = {}, initialState = {} } = {}, { max = 8 } = {}) {
  const out = [{ name: 'default', props: {}, state: {} }];
  for (const [k, d] of Object.entries(props)) {
    if (k.startsWith('$') || !d || typeof d !== 'object') continue;
    if (d.editor === 'boolean' || typeof d.default === 'boolean') out.push({ name: `${k}=${!d.default}`, props: { [k]: !d.default }, state: {} });
    const options = Array.isArray(d.options) ? d.options.map((o) => (o && typeof o === 'object' ? o.value : o)) : [];
    for (const o of options) if (o !== d.default && ['string', 'number'].includes(typeof o)) out.push({ name: `${k}=${o}`, props: { [k]: o }, state: {} });
  }
  for (const [k, v] of Object.entries(initialState ?? {})) if (typeof v === 'boolean') out.push({ name: `state.${k}=${!v}`, props: {}, state: { [k]: !v } });
  return out.slice(0, max);
}

const slug = (s) => String(s).replace(/\.dc\.html?$|\.html?$/i, '').replace(/[^\w.=-]+/g, '-').replace(/^-+|-+$/g, '');

// The cache key of a set of mockups: their names and bytes, and the renderer version.
export function mockupSha(files) {
  const h = createHash('sha256');
  h.update(`renderer ${RENDERER_VERSION}\n`);
  for (const f of [...files].sort()) {
    h.update(`${path.basename(path.dirname(f))}/${path.basename(f)}\n`);
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Rendering (Playwright)
// ---------------------------------------------------------------------------------------------

export async function loadChromium() {
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    try {
      const mod = await import(name);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch {
      // try the next package
    }
  }
  throw new Error('Playwright is not available (run `npm ci` and `npx playwright install chromium`)');
}

// The in-page canvas runtime: renders the template for one variant and reports props and initial state.
export function dcRuntime({ template, variant }) {
  const evalExpr = (expr, scope) => {
    try {
      return new Function('scope', `with (scope) { return (${expr}); }`)(scope);
    } catch {
      return undefined;
    }
  };
  const fill = (text, scope) => {
    const whole = /^\s*\{\{([\s\S]+?)\}\}\s*$/.exec(text);
    if (whole) return evalExpr(whole[1], scope);
    return text.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
      const v = evalExpr(e, scope);
      return v == null ? '' : String(v);
    });
  };
  const walkNode = (node, scope) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        if (child.nodeValue.includes('{{')) child.nodeValue = String(fill(child.nodeValue, scope) ?? '');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const kind = child.tagName === 'TEMPLATE' ? child.getAttribute('data-sc') : null;
      if (kind === 'if') {
        const frag = child.content.cloneNode(true);
        if (fill(child.getAttribute('value') ?? '', scope)) {
          walkNode(frag, scope);
          child.replaceWith(...frag.childNodes);
        } else child.remove();
        continue;
      }
      if (kind === 'for') {
        const list = fill(child.getAttribute('list') ?? '', scope);
        const as = child.getAttribute('as') || 'item';
        const out = [];
        (Array.isArray(list) ? list : []).forEach((item, index) => {
          const frag = child.content.cloneNode(true);
          walkNode(frag, { ...scope, [as]: item, index });
          out.push(...frag.childNodes);
        });
        child.replaceWith(...out);
        continue;
      }
      for (const attr of [...child.attributes]) {
        if (!attr.value.includes('{{')) continue;
        const v = fill(attr.value, scope);
        if (/^on/i.test(attr.name)) {
          child.removeAttribute(attr.name);
          if (typeof v === 'function') child.addEventListener(attr.name.slice(2).toLowerCase(), v);
        } else if (/^aria-/i.test(attr.name)) child.setAttribute(attr.name, String(v));
        else if (v === false || v == null) child.removeAttribute(attr.name);
        else child.setAttribute(attr.name, v === true ? '' : String(v));
      }
      walkNode(child.tagName === 'TEMPLATE' ? child.content : child, scope);
    }
  };
  const render = () => {
    const root = document.querySelector('x-dc');
    const script = document.querySelector('script[data-dc-script]');
    let propsDef;
    try {
      propsDef = JSON.parse(script?.getAttribute('data-props') || '{}');
    } catch {
      propsDef = {};
    }
    const props = {};
    for (const [k, d] of Object.entries(propsDef)) if (!k.startsWith('$') && d && typeof d === 'object' && 'default' in d) props[k] = d.default;
    Object.assign(props, variant.props ?? {});
    let comp = null;
    class DCLogic {
      constructor(p) {
        this.props = p;
        this.state = {};
      }
      setState(s) {
        Object.assign(this.state, typeof s === 'function' ? s(this.state) : s);
        paint();
      }
    }
    const paint = () => {
      const vals = comp?.renderVals ? comp.renderVals() : {};
      root.innerHTML = template;
      walkNode(root, { ...props, ...vals });
    };
    if (script) {
      const Component = new Function('DCLogic', `${script.textContent}\n;return typeof Component !== 'undefined' ? Component : null;`)(DCLogic);
      if (Component) comp = new Component(props);
    }
    const initialState = comp ? JSON.parse(JSON.stringify(comp.state ?? {})) : {};
    if (comp) Object.assign(comp.state, variant.state ?? {});
    if (root) paint();
    window.__dc = { props: propsDef, initialState };
  };
  document.addEventListener('DOMContentLoaded', () => {
    try {
      render();
    } catch (error) {
      window.__dc = { error: String(error?.stack ?? error) };
    }
  });
}

async function shoot(browser, file, { size, variant = null, template = null, out, timeoutMs }) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  // Mockups are rendered offline: web fonts and other remote assets fall back.
  await context.route(/^(https?|wss?):/i, (route) => route.abort());
  try {
    const page = await context.newPage();
    if (variant) await page.addInitScript(dcRuntime, { template, variant });
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: timeoutMs }).catch(() => {});
    const info = variant ? await page.evaluate(() => window.__dc ?? null).catch(() => null) : null;
    await page.screenshot({ path: out, fullPage: true, timeout: timeoutMs });
    return info;
  } finally {
    await context.close();
  }
}

function boardsOf(files) {
  const boards = {};
  for (const f of files.filter((x) => path.basename(x) === 'canvas.json')) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [name, b] of Object.entries(c.boards ?? {})) boards[path.join(path.dirname(f), name)] = b;
    } catch {
      // not a canvas index
    }
  }
  return boards;
}

// Renders every screen (and its states) of the mockup files to PNGs. Returns the manifest entries:
// { kind: 'screen' | 'image', source, screen, title, state, png, width, height, error }.
export async function renderScreens(files, outDir, { maxStates = 8, timeoutMs = 20000 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const boards = boardsOf(files);
  const entries = [];
  for (const f of files.filter((x) => IMAGE.test(x))) entries.push({ kind: 'image', source: f, screen: path.basename(f), title: null, state: null, png: f });
  const screens = files.filter((x) => SCREEN.test(x));
  if (!screens.length) return entries;
  const chromium = await loadChromium();
  const browser = await chromium.launch();
  try {
    const used = new Set();
    for (const file of screens) {
      const html = fs.readFileSync(file, 'utf8');
      const board = boards[file] ?? null;
      const size = screenSize(html, board);
      const base = slug(`${path.basename(path.dirname(file))}__${path.basename(file)}`);
      const name = (state) => {
        let n = `${base}${state === 'default' ? '' : `--${slug(state)}`}`;
        while (used.has(n)) n += '_';
        used.add(n);
        return path.join(outDir, `${n}.png`);
      };
      const entry = (state, png, extra = {}) => ({ kind: 'screen', source: file, screen: path.basename(file), title: board?.title ?? null, state, png, ...size, ...extra });
      if (!isDesignCanvas(html)) {
        const png = name('default');
        try {
          await shoot(browser, file, { size, out: png, timeoutMs });
          entries.push(entry('default', png, { format: 'html' }));
        } catch (error) {
          entries.push(entry('default', null, { format: 'html', error: error.message.split('\n')[0] }));
        }
        continue;
      }
      const template = dcTemplate(html);
      const first = name('default');
      let info = null;
      try {
        info = await shoot(browser, file, { size, variant: { props: {}, state: {} }, template, out: first, timeoutMs });
        entries.push(entry('default', first, { format: 'dc', ...(info?.error ? { error: info.error.split('\n')[0] } : {}) }));
      } catch (error) {
        entries.push(entry('default', null, { format: 'dc', error: error.message.split('\n')[0] }));
        continue;
      }
      for (const variant of dcVariants({ props: info?.props ?? dcProps(html), initialState: info?.initialState ?? {} }, { max: maxStates }).slice(1)) {
        const png = name(variant.name);
        try {
          const v = await shoot(browser, file, { size, variant, template, out: png, timeoutMs });
          entries.push(entry(variant.name, png, { format: 'dc', ...(v?.error ? { error: v.error.split('\n')[0] } : {}) }));
        } catch (error) {
          entries.push(entry(variant.name, null, { format: 'dc', error: error.message.split('\n')[0] }));
        }
      }
    }
  } finally {
    await browser.close();
  }
  return entries;
}

// Renders a story's mockups into `outDir` (a round's `mockup/` folder), reusing an earlier render of the
// same files from `cacheDir/<sha>/` (rendered once per set of mockups, copied into every round). Never
// throws: a render that cannot run returns { ok: false, error } and the verifier reads the sources.
export async function renderMockups({ files, outDir, cacheDir, render = renderScreens, maxStates = 8 }) {
  if (!files?.length) return { ok: true, sha: null, cached: false, entries: [] };
  const sha = mockupSha(files);
  const cached = path.join(cacheDir, sha.slice(0, 16));
  const manifestFile = path.join(cached, 'manifest.json');
  let hit = fs.existsSync(manifestFile);
  let manifest = null;
  if (hit) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch {
      hit = false;
    }
  }
  if (!hit) {
    try {
      fs.rmSync(cached, { recursive: true, force: true });
      const entries = await render(files, cached, { maxStates });
      manifest = { sha, rendererVersion: RENDERER_VERSION, entries: entries.map((e) => ({ ...e, png: e.png && e.kind === 'screen' ? path.basename(e.png) : e.png })) };
      fs.mkdirSync(cached, { recursive: true });
      fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      return { ok: false, sha, cached: false, error: error.message.split('\n')[0], entries: [] };
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const entries = manifest.entries.map((e) => {
    if (e.kind !== 'screen' || !e.png) return e;
    const dest = path.join(outDir, e.png);
    fs.copyFileSync(path.join(cached, e.png), dest);
    return { ...e, png: dest };
  });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({ sha, cached: hit, entries }, null, 2)}\n`);
  return { ok: true, sha, cached: hit, entries };
}

// The rendered screens for an agent's task, one line each.
export function formatRenders(entries) {
  return entries
    .map((e) => {
      if (e.kind === 'image') return `- image ${e.screen}: ${e.png}`;
      const what = `${e.screen}${e.title ? ` (${e.title})` : ''}, state ${e.state}`;
      return e.png ? `- ${what}: ${e.png}${e.error ? ` (rendered with an error: ${e.error})` : ''}` : `- ${what}: not rendered (${e.error ?? 'unknown error'}); read ${e.source}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Pixel diff (supporting evidence only)
// ---------------------------------------------------------------------------------------------

// Compares two PNGs in Chromium and writes a diff image (differing pixels red over a faded copy of the
// actual screenshot). Size differences count as differing pixels. Returns { width, height, differing, ratio }.
export async function pixelDiff(mockupPng, actualPng, outPng, { threshold = 32 } = {}) {
  const chromium = await loadChromium();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const data = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    const result = await page.evaluate(
      async ({ a, b, threshold: t }) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('not an image'));
            img.src = src;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const width = Math.max(ia.width, ib.width);
        const height = Math.max(ia.height, ib.height);
        const pixels = (img) => {
          const c = document.createElement('canvas');
          c.width = width;
          c.height = height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, width, height).data;
        };
        const pa = pixels(ia);
        const pb = pixels(ib);
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        const out = ctx.createImageData(width, height);
        let differing = 0;
        for (let i = 0; i < pa.length; i += 4) {
          const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) + Math.abs(pa[i + 3] - pb[i + 3]);
          if (d > t) {
            differing++;
            out.data.set([255, 0, 0, 255], i);
          } else {
            const g = 255 - Math.round((255 - (pb[i] + pb[i + 1] + pb[i + 2]) / 3) * 0.3);
            out.data.set([g, g, g, 255], i);
          }
        }
        ctx.putImageData(out, 0, 0);
        return { width, height, differing, ratio: differing / (width * height), png: c.toDataURL('image/png') };
      },
      { a: data(mockupPng), b: data(actualPng), threshold },
    );
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    fs.writeFileSync(outPng, Buffer.from(result.png.split(',')[1], 'base64'));
    return { width: result.width, height: result.height, differing: result.differing, ratio: Math.round(result.ratio * 10000) / 10000, diff: outPng };
  } finally {
    await browser.close();
  }
}
