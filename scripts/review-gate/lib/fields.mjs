// The review gate's fields on the story board (a GitHub Project), created by `board setup`:
// Impact, Complexity, Fix risk and Severity (single-select Low / Medium / High / Severe; Severity is
// derived by the harness), Confidence and Human reopens (numbers). Names are in `board.fields`.
import { LEVELS } from './levels.mjs';
import { ghJson, ghOk } from './github.mjs';

export const FIELD_DEFAULTS = { impact: 'Impact', complexity: 'Complexity', fixRisk: 'Fix risk', severity: 'Severity', confidence: 'Confidence', reopens: 'Human reopens' };
const SELECT = ['impact', 'complexity', 'fixRisk', 'severity'];
const NUMBER = ['confidence', 'reopens'];

export const fieldNames = (config) => ({ ...FIELD_DEFAULTS, ...(config.board?.fields ?? {}) });

function graphql(gh, query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return ghJson(gh, args).data;
}

// { projectId, fields: { <name>: { id, dataType, options: { <option>: id } } } }
export function projectFields(config, gh) {
  const { owner, ownerType, projectNumber } = config.board;
  const p = graphql(
    gh,
    `query($owner:String!,$number:Int!){${ownerType}(login:$owner){projectV2(number:$number){id fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name}}}}}}}`,
    { owner, number: projectNumber },
  )[ownerType].projectV2;
  const fields = {};
  for (const f of p.fields.nodes) if (f?.name) fields[f.name] = { id: f.id, dataType: f.dataType, options: Object.fromEntries((f.options ?? []).map((o) => [o.name, o.id])) };
  return { projectId: p.id, fields };
}

// Creates the fields that are missing (idempotent). Returns the names created.
export function ensureFields(config, gh, { log = () => {} } = {}) {
  const names = fieldNames(config);
  const { fields } = projectFields(config, gh);
  const created = [];
  for (const k of [...SELECT, ...NUMBER]) {
    const name = names[k];
    const have = fields[name];
    if (have) {
      if (SELECT.includes(k) && LEVELS.some((l) => !have.options[l])) log(`field "${name}" exists without every option (${LEVELS.join(', ')}); add the missing ones in the project settings`);
      continue;
    }
    const args = ['project', 'field-create', String(config.board.projectNumber), '--owner', config.board.owner, '--name', name];
    args.push(...(SELECT.includes(k) ? ['--data-type', 'SINGLE_SELECT', '--single-select-options', LEVELS.join(',')] : ['--data-type', 'NUMBER']));
    ghOk(gh, args);
    created.push(name);
  }
  log(created.length ? `triage fields created: ${created.join(', ')}` : 'triage fields ready');
  return created;
}

// The issue's item id on the project (added when missing).
export function itemIdFor(config, gh, { number, url }) {
  const [owner, name] = config.board.repo.split('/');
  const p = projectFields(config, gh);
  const data = graphql(gh, 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){projectItems(first:50){nodes{id project{id}}}}}}', { owner, name, number });
  const item = data.repository.issue.projectItems.nodes.find((n) => n.project.id === p.projectId);
  if (item) return { itemId: item.id, project: p };
  const added = ghJson(gh, ['project', 'item-add', String(config.board.projectNumber), '--owner', config.board.owner, '--url', url, '--format', 'json']);
  return { itemId: added.id, project: p };
}

// Writes the triage values of one ticket to its card: { impact, complexity, fixRisk, severity, confidence, reopens }
// (null clears a field). Fields the project does not have are skipped (run `board setup`). Returns the
// names written.
export function setTriageFields(config, gh, issue, values) {
  const names = fieldNames(config);
  const { itemId, project } = itemIdFor(config, gh, issue);
  const written = [];
  for (const [k, v] of Object.entries(values)) {
    const f = project.fields[names[k]];
    if (!f || v === undefined) continue;
    const base = ['project', 'item-edit', '--id', itemId, '--project-id', project.projectId, '--field-id', f.id];
    if (v === null) ghOk(gh, [...base, '--clear']);
    else if (SELECT.includes(k)) {
      if (!f.options[v]) continue;
      ghOk(gh, [...base, '--single-select-option-id', f.options[v]]);
    } else ghOk(gh, [...base, '--number', String(v)]);
    written.push(names[k]);
  }
  return written;
}
