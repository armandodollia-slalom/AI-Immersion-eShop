import fs from 'node:fs';
import path from 'node:path';
import { fsReader, currentBranch } from './git.mjs';
import { sha } from './util.mjs';

const KEY = /^([A-Z][A-Z0-9]*-\d+)-/;
export const CASE_ID = /TC-([A-Z][A-Z0-9]*-\d+)-(\d{2,})(?!\d)/g;

export function listStories(config, reader = fsReader(config.root)) {
  return reader
    .list(config.storiesDir)
    .filter((name) => name.endsWith('.md') && KEY.test(name))
    .map((name) => {
      const slug = name.slice(0, -3);
      return {
        key: KEY.exec(name)[1],
        slug,
        file: `${config.storiesDir}/${name}`,
        planDir: config.plansDir ? `${config.plansDir}/${slug}` : null,
        scenario: KEY.exec(name)[1].toLowerCase(),
      };
    });
}

export function resolveStory(config, arg, reader) {
  if (!arg) return null;
  const needle = path.basename(String(arg)).replace(/\.md$/, '').toUpperCase();
  const stories = listStories(config, reader);
  return (
    stories.find((s) => s.key === needle) ??
    stories.find((s) => s.slug.toUpperCase() === needle) ??
    stories.find((s) => needle.startsWith(`${s.key}-`)) ??
    null
  );
}

export function storiesFromPaths(config, paths, reader) {
  const prefix = `${config.storiesDir}/`;
  const keys = new Set(
    paths.filter((p) => p.startsWith(prefix) && p.endsWith('.md')).map((p) => path.basename(p)),
  );
  return listStories(config, reader).filter((s) => keys.has(path.basename(s.file)));
}

// Epics are the epic-*.md files next to the stories folder; an epic owns every story key it mentions.
export function listEpics(config, reader = fsReader(config.root)) {
  const dir = path.posix.dirname(config.storiesDir);
  return reader
    .list(dir)
    .filter((name) => /^epic-.+\.md$/.test(name))
    .map((name) => {
      const text = reader.read(`${dir}/${name}`) ?? '';
      const title = /^#\s+(?:Epic:\s*)?(.+)$/m.exec(text)?.[1]?.trim() ?? name;
      return { key: name.slice('epic-'.length, -3), title, file: `${dir}/${name}`, stories: new Set([...text.matchAll(/\b([A-Z][A-Z0-9]*-\d+)(?!\d)/g)].map((m) => m[1])) };
    });
}

export function epicOf(config, key, epics = listEpics(config)) {
  return epics.find((e) => e.stories.has(key)) ?? null;
}

export const storySha = (text) => sha(text.replace(/\r\n/g, '\n'));

export const casePrefix = (key) => `TC-${key}-`;

export function caseIdsIn(text, key) {
  const ids = new Set();
  for (const match of text.matchAll(CASE_ID)) {
    if (!key || match[1] === key) ids.add(match[0]);
  }
  return ids;
}

export function activeStory(config) {
  const file = path.join(config.root, config.stateDir, 'active-story');
  if (fs.existsSync(file)) {
    const story = resolveStory(config, fs.readFileSync(file, 'utf8').trim());
    if (story) return story;
  }
  const branch = currentBranch(config.root).toUpperCase();
  for (const match of branch.matchAll(/([A-Z][A-Z0-9]*-\d+)/g)) {
    const story = resolveStory(config, match[1]);
    if (story) return story;
  }
  return null;
}
