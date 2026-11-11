// Solution filter generator: the projects a story owns plus everything they reference, so the C# language server
// loads a few projects instead of the whole eShop.slnx.
import fs from 'node:fs';
import path from 'node:path';

const toPosix = (p) => p.replace(/\\/g, '/');

// Glob to RegExp: `**` spans directories (and may match nothing), `*` and `?` stay within one segment.
export function globToRegExp(glob) {
  let re = '';
  const g = toPosix(glob).replace(/^\.\//, '').replace(/\/+$/, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      const before = i === 0 || g[i - 1] === '/';
      const after = g[i + 2] === '/' || i + 2 === g.length;
      if (before && after) {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          if (re.endsWith('/')) re = `${re.slice(0, -1)}(?:/.*)?`;
          else re += '.*';
          i += 1;
        }
        continue;
      }
      re += '[^/]*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Literal directory prefix of a glob ("src/Catalog.API/Apis/*.cs" -> "src/Catalog.API/Apis").
const globBase = (glob) => {
  const parts = toPosix(glob).replace(/^\.\//, '').split('/');
  const literal = [];
  for (const part of parts) {
    if (/[*?[]/.test(part)) break;
    literal.push(part);
  }
  return literal.join('/');
};

// A project is owned when a glob matches its directory, or names files inside it (the glob's literal base is the
// project directory or below it).
export function projectMatches(projectDir, glob) {
  const dir = toPosix(projectDir).replace(/\/+$/, '');
  if (globToRegExp(glob).test(dir)) return true;
  const base = globBase(glob);
  return base !== '' && (base === dir || base.startsWith(`${dir}/`));
}

export function solutionProjects(solutionFile) {
  const text = fs.readFileSync(solutionFile, 'utf8');
  if (solutionFile.endsWith('.slnx')) {
    return [...text.matchAll(/<Project\s+[^>]*Path="([^"]+\.csproj)"/g)].map((m) => toPosix(m[1]));
  }
  return [...text.matchAll(/"([^"]+\.csproj)"/g)].map((m) => toPosix(m[1]));
}

export function projectReferences(projectFile) {
  if (!fs.existsSync(projectFile)) return [];
  const text = fs.readFileSync(projectFile, 'utf8');
  return [...text.matchAll(/<ProjectReference\s+[^>]*Include="([^"]+)"/g)].map((m) =>
    path.resolve(path.dirname(projectFile), toPosix(m[1])),
  );
}

/**
 * @param {object} options
 * @param {string} options.root      checkout root (where the solution lives)
 * @param {string[]} options.owns    globs relative to root
 * @param {string} [options.solution] solution file relative to root (default eShop.slnx)
 * @param {string} [options.out]     .slnf to write (absolute or relative to root); omitted = don't write
 * @returns {{ok: boolean, projects: string[], solution: string, out?: string, error?: string}}
 */
export function generateSlnf({ root, owns, solution = 'eShop.slnx', out }) {
  const solutionFile = path.resolve(root, solution);
  if (!fs.existsSync(solutionFile)) return { ok: false, projects: [], solution, error: `${solution} not found in ${root}` };
  if (!owns?.length) return { ok: false, projects: [], solution, error: 'at least one --owns glob is required' };

  const inSolution = new Map(solutionProjects(solutionFile).map((p) => [path.resolve(path.dirname(solutionFile), p), p]));
  const seeds = [...inSolution.keys()].filter((abs) => {
    const dir = path.relative(root, path.dirname(abs));
    return owns.some((glob) => projectMatches(dir, glob));
  });
  if (!seeds.length) return { ok: false, projects: [], solution, error: `no project in ${solution} matches ${owns.join(', ')}` };

  const closure = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const abs = queue.shift();
    if (closure.has(abs)) continue;
    closure.add(abs);
    queue.push(...projectReferences(abs));
  }
  // Referenced projects outside the solution cannot be in a filter of it; MSBuild still loads them as references.
  const projects = [...closure]
    .map((abs) => toPosix(path.relative(path.dirname(solutionFile), abs)))
    .filter((rel) => [...inSolution.values()].includes(rel))
    .sort();

  const result = { ok: true, projects, solution };
  if (out) {
    const outFile = path.resolve(root, out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const slnf = {
      solution: {
        path: toPosix(path.relative(path.dirname(outFile), solutionFile)),
        projects: projects.map((p) => p.replace(/\//g, '\\')),
      },
    };
    fs.writeFileSync(outFile, `${JSON.stringify(slnf, null, 2)}\n`);
    result.out = outFile;
  }
  return result;
}
