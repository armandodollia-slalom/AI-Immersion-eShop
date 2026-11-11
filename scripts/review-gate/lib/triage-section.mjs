// The `## Triage` section of a bug ticket's issue body: the review gate's reasoning for each field,
// next to a hidden copy of the data (`<!-- bug-triage:data:{...} -->`). The issue is the source of
// truth: reopens and severity bumps are read back from here on every machine. The section sits outside
// the ticket's source markers, so agents never read it as part of the story, and `board publish`
// carries it over to the re-rendered body (keepTriage).

const BEGIN = '<!-- bug-triage:begin -->';
const END = '<!-- bug-triage:end -->';
const DATA = /<!-- bug-triage:data:(\{.*?\}) -->/;
const encode = (o) => `<!-- bug-triage:data:${JSON.stringify(o).replace(/--/g, '-\\u002d')} -->`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '-';

export function renderTriage(t) {
  const reopens = t.reopens ?? [];
  const lines = [
    BEGIN,
    '## Triage',
    '',
    `_Written by the [review gate](../blob/main/docs/ai-pipeline/review-gate.md) for ${t.pr ?? 'the fix PR'} on ${String(t.assessedAt ?? '').slice(0, 10) || 'an unknown date'}. Ratings come from the \`bug-triage\` agent; Severity and Confidence are computed by the harness. Edits here are overwritten._`,
    '',
    '| Field | Level | Why |',
    '| --- | --- | --- |',
    `| Impact | ${cell(t.impact)} | ${cell(t.impactReason)} |`,
    `| Complexity | ${cell(t.complexity)} | ${cell(t.complexityReason)} (feeds into Fix risk) |`,
    `| Fix risk | ${cell(t.fixRisk)} | ${cell(t.fixRiskReason)} |`,
    `| **Severity** | **${cell(t.severity?.level ?? 'not assessed')}** | ${cell(t.severity?.explanation)} |`,
    `| Confidence | ${t.confidence?.score ?? '-'}/100${t.confidence?.high ? ' (high)' : ''} | ${cell(t.confidence?.reasons?.length ? `not high: ${t.confidence.reasons.join('; ')}` : 'every signal met')} |`,
    '',
    `- **Systems touched by the PR:** ${t.systems?.length ? t.systems.join(', ') : 'none'}`,
    ...(t.floorReasons?.length ? [`- **Severity floor:** ${t.floorReasons.join(', ')}`] : []),
    `- **Human reopens:** ${reopens.length}${reopens.length ? `, each +1 severity and no auto-merge: ${reopens.map((r) => `${String(r.at).slice(0, 10)} ${r.source}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}` : ''}`,
    ...(t.summary ? [`- **Summary:** ${t.summary.replace(/\s+/g, ' ')}`] : []),
    '',
    encode(t),
    END,
  ];
  return lines.join('\n');
}

// The triage data stored in a body, or null.
export function extractTriage(body) {
  const b = String(body ?? '');
  const start = b.indexOf(BEGIN);
  const end = start < 0 ? -1 : b.indexOf(END, start);
  if (start < 0 || end < 0) return null;
  const m = DATA.exec(b.slice(start, end));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// The body with the triage section added or replaced.
export function upsertTriage(body, triage) {
  const b = String(body ?? '').replace(/\r\n/g, '\n');
  const section = renderTriage(triage);
  const start = b.indexOf(BEGIN);
  const end = start < 0 ? -1 : b.indexOf(END, start);
  if (start >= 0 && end >= 0) return `${b.slice(0, start)}${section}${b.slice(end + END.length)}`;
  return `${b.trimEnd()}\n\n${section}\n`;
}

// Carries the triage section of `from` (the body on GitHub) over to a re-rendered body.
export function keepTriage(body, from) {
  const b = String(from ?? '').replace(/\r\n/g, '\n');
  const start = b.indexOf(BEGIN);
  const end = start < 0 ? -1 : b.indexOf(END, start);
  if (start < 0 || end < 0 || String(body).includes(BEGIN)) return body;
  return `${String(body).trimEnd()}\n\n${b.slice(start, end + END.length)}\n`;
}
