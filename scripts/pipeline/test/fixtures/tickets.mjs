// Test helper: puts a ticket into a fixture checkout's ticket cache (.agent-state/board/<KEY>/), the way
// `board fetch` would after reading its issue. Calling it again with new text is an updated issue.
import fs from 'node:fs';
import path from 'node:path';
import { writeTicket } from '../../../board/lib/source.mjs';
import { metaFor } from '../../../board/lib/ticket-format.mjs';
import { blockersOf } from '../../../implement/lib/batch.mjs';

export const CACHE = '.agent-state/board';

export function seedTicket(root, { key, text, slug = null, type = 'story', parent = null, number = null, updatedAt = '2026-01-01T00:00:00Z', mockups = {} }) {
  const config = { root, tickets: { dir: CACHE, repo: 'example/repo' } };
  const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? key;
  const meta = metaFor({ key, type, title, slug: slug ?? key, source: null, parent, blockedBy: blockersOf(text, key) }, text);
  writeTicket(config, key, { content: text, meta, issue: number ? { number, url: `https://github.com/example/repo/issues/${number}`, updatedAt, state: 'OPEN', title, labels: [] } : null });
  for (const [name, content] of Object.entries(mockups)) {
    const file = path.join(root, CACHE, key, 'mockups', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return `${CACHE}/${key}/story.md`;
}
