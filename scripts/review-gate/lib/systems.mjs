// Systems touched by a fix PR: every changed file mapped to its project or service in the solution
// (`implement.reviewGate.systems`, globs as in a subtask's `owns`). Shared infrastructure (EventBus,
// ServiceDefaults, integration-event contracts, the AppHost, build files) counts as its own system.
// Files matching `ignore` (tests, docs, metrics) touch no system; any other file is "Other".
import { matchGlob, matchesAny } from '../../implement/lib/plan.mjs';

export const OTHER = 'Other';

// Every system the file belongs to. A file can belong to several: an integration event under
// src/Ordering.API is both Ordering.API and the integration-event contract.
export function systemsOf(file, settings) {
  if (matchesAny(file, settings.ignore ?? [])) return [];
  const hits = (settings.systems ?? []).filter((s) => matchesAny(file, s.paths ?? []));
  return hits.length ? hits : [{ name: OTHER, paths: [], shared: false }];
}

// { systems: [{ name, shared, contract, files }], shared: bool, contract: bool, names: [...] } for the
// changed files, systems in configuration order.
export function systemsTouched(files, settings) {
  const byName = new Map();
  for (const file of files ?? []) {
    for (const s of systemsOf(file, settings)) {
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, shared: Boolean(s.shared), contract: Boolean(s.contract), files: [] });
      byName.get(s.name).files.push(file);
    }
  }
  const order = [...(settings.systems ?? []).map((s) => s.name), OTHER];
  const systems = [...byName.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return {
    systems,
    names: systems.map((s) => s.name),
    shared: systems.some((s) => s.shared),
    contract: systems.some((s) => s.contract),
  };
}

// The configured override paths (`floor.paths`) the files hit, with the files that hit each.
export function overridePathsHit(files, settings) {
  return (settings.floor?.paths ?? [])
    .map((glob) => ({ path: glob, files: (files ?? []).filter((f) => matchGlob(f, glob)) }))
    .filter((h) => h.files.length);
}

// ---------------------------------------------------------------------------------------------
// CODEOWNERS: the fallback reviewers of the systems touched
// ---------------------------------------------------------------------------------------------

// Parses a CODEOWNERS file into rules [{ pattern, owners }] in file order (the last match wins).
export function parseCodeowners(text) {
  const rules = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners: owners.filter((o) => o.startsWith('@')).map((o) => o.slice(1)) });
  }
  return rules;
}

// CODEOWNERS pattern semantics, close enough for owner lookup: `*` alone is everything; a pattern with
// no slash (or only a trailing one) matches at any depth; a leading slash anchors at the root; a
// trailing slash or a directory matches its whole subtree.
export function codeownersMatch(file, pattern) {
  if (pattern === '*' || pattern === '/*' || pattern === '**') return true;
  let p = pattern;
  const anchored = p.startsWith('/') || p.replace(/\/$/, '').includes('/');
  p = p.replace(/^\//, '');
  const dir = p.endsWith('/');
  p = p.replace(/\/$/, '');
  const globs = anchored ? [p, `${p}/**`] : [`**/${p}`, `**/${p}/**`, p, `${p}/**`];
  return globs.some((g) => (dir && !g.endsWith('/**') ? false : matchGlob(file, g)));
}

// The owners of a file: the owners of the last rule that matches it.
export function ownersOf(file, rules) {
  let owners = [];
  for (const r of rules) if (codeownersMatch(file, r.pattern)) owners = r.owners;
  return owners;
}

// Owners of a set of files (team handles like org/team are kept as they are).
export const ownersOfFiles = (files, rules) => [...new Set((files ?? []).flatMap((f) => ownersOf(f, rules)))];
