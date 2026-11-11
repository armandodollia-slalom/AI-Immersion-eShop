// Maps changed files to the test-stack compose services whose images they affect, by walking each service
// project's MSBuild references (ProjectReference, plus Compile/Protobuf/Content items linked from outside the
// project folder, such as src/Shared/*.cs or Basket.API's basket.proto).
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadConfig } from './ports.mjs';

const INCLUDE = /\b(ProjectReference|Compile|Content|None|Protobuf|EmbeddedResource|AdditionalFiles)\s[^>]*?\bInclude\s*=\s*["']([^"']+)["']/g;

/** Normalizes a path to repo-relative POSIX form ("./src\\X" -> "src/X"). */
export function normalizePath(file) {
  return path.posix.normalize(String(file).trim().replace(/\\/g, '/')).replace(/^(\.\/)+/, '');
}

// Literal part of an MSBuild include ("..\\Shared\\*.cs" -> "../Shared/"); null when it starts with a property.
function literalPrefix(include) {
  const text = include.replace(/\\/g, '/');
  if (text.includes('$(')) return null;
  const wildcard = text.search(/[*?]/);
  if (wildcard < 0) return text;
  return text.slice(0, text.lastIndexOf('/', wildcard) + 1);
}

/**
 * Repo-relative paths a project depends on: its own folder, the folders of every project it references
 * (transitively) and any file or folder it includes from outside its folder. Folders end with "/".
 */
export function projectInputs(csproj, { root = REPO_ROOT, seen = new Set() } = {}) {
  const project = normalizePath(csproj);
  if (seen.has(project)) return [];
  seen.add(project);
  const dir = `${path.posix.dirname(project)}/`;
  const inputs = [dir];
  let text;
  try {
    text = fs.readFileSync(path.join(root, project), 'utf8');
  } catch {
    return inputs;
  }
  for (const [, kind, include] of text.matchAll(INCLUDE)) {
    for (const part of include.split(';')) {
      const prefix = literalPrefix(part.trim());
      if (!prefix) continue;
      const resolved = path.posix.normalize(path.posix.join(dir, prefix));
      if (resolved.startsWith('..')) continue;
      if (kind === 'ProjectReference') {
        inputs.push(...projectInputs(resolved, { root, seen }));
      } else if (!resolved.startsWith(dir)) {
        inputs.push(prefix.endsWith('/') ? `${resolved.replace(/\/?$/, '/')}` : resolved);
      }
    }
  }
  return [...new Set(inputs)];
}

/** Input paths of every compose service with a built image: { "webapp": ["src/WebApp/", ...], ... }. */
export function serviceInputs({ root = REPO_ROOT, config = loadConfig() } = {}) {
  return Object.fromEntries(Object.entries(config.services).map(([name, csproj]) => [name, projectInputs(csproj, { root })]));
}

const matches = (file, input) => (input.endsWith('/') ? file.startsWith(input) : file === input);

/**
 * Compose services whose images must be rebuilt for the given changed files, in config order. Global build
 * inputs (Directory.Packages.props, global.json, the AppHost, the compose file, ...) select every service.
 * Returns { services, all, reasons } where reasons maps each selected service to the files that selected it.
 */
export function servicesFor(files, { root = REPO_ROOT, config = loadConfig(), inputs } = {}) {
  const normalized = [...new Set(files.map(normalizePath).filter(f => f && f !== '.'))];
  const names = Object.keys(config.services);
  const global = normalized.filter(f => config.rebuildAll.some(input => matches(f, input)));
  if (global.length) {
    return { services: names, all: true, reasons: Object.fromEntries(names.map(n => [n, global])) };
  }
  const byService = inputs ?? serviceInputs({ root, config });
  const reasons = {};
  for (const name of names) {
    const hits = normalized.filter(f => byService[name].some(input => matches(f, input)));
    if (hits.length) reasons[name] = hits;
  }
  return { services: Object.keys(reasons), all: false, reasons };
}
