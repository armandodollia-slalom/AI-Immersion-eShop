// An in-memory GitHub for the board ticket tests: answers the `gh` calls the ticket modules make
// (issue list/view/create/edit, label create, project item-add, and the GraphQL queries for sub-issues
// and edit history). Inject it as the `gh` runner. `offline = true` makes every call fail.
export function fakeGitHub(repo = 'acme/shop') {
  const issues = new Map();
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();
  const state = { issues, calls: [], offline: false, writes: 0 };
  const ok = (stdout) => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
  const view = (i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels.map((name) => ({ name })), state: i.state, updatedAt: i.updatedAt, url: i.url });
  const flag = (args, name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const field = (args, name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

  state.add = ({ title, body = '', labels = [], parent = null }) => {
    const number = issues.size + 1;
    issues.set(number, { number, title, body, labels: [...labels], state: 'OPEN', updatedAt: tick(), url: `https://github.com/${repo}/issues/${number}`, parent, edits: [] });
    return number;
  };
  state.edit = (number, body) => {
    const i = issues.get(number);
    i.edits.unshift({ diff: i.body });
    i.body = body;
    i.updatedAt = tick();
  };

  state.gh = (args, { input } = {}) => {
    state.calls.push(args);
    if (state.offline) return { status: 1, stdout: '', stderr: 'error connecting to api.github.com' };
    const [a, b] = args;
    if (a === 'issue' && b === 'list') return ok([...issues.values()].map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((name) => ({ name })), state: i.state, updatedAt: i.updatedAt, url: i.url })));
    if (a === 'issue' && b === 'view') {
      const i = issues.get(Number(args[2]));
      return i ? ok(view(i)) : { status: 1, stdout: '', stderr: 'not found' };
    }
    if (a === 'issue' && b === 'create') {
      state.writes++;
      const labels = args.flatMap((x, k) => (x === '--label' ? [args[k + 1]] : []));
      const n = state.add({ title: flag(args, '--title'), body: input, labels });
      return ok(`${issues.get(n).url}\n`);
    }
    if (a === 'issue' && b === 'edit') {
      state.writes++;
      const i = issues.get(Number(args[2]));
      if (args.includes('--body-file')) state.edit(i.number, input);
      if (flag(args, '--title')) i.title = flag(args, '--title');
      for (const l of (flag(args, '--add-label') ?? '').split(',').filter(Boolean)) if (!i.labels.includes(l)) i.labels.push(l);
      i.updatedAt = tick();
      return ok('');
    }
    if (a === 'label' || a === 'project') return ok('{}');
    if (a === 'api' && b === 'graphql') {
      const query = field(args, 'query') ?? '';
      if (query.includes('addSubIssue')) {
        state.writes++;
        const child = [...issues.values()].find((i) => `ID_${i.number}` === field(args, 'c'));
        child.parent = Number(field(args, 'p').slice(3));
        return ok({ data: { addSubIssue: { issue: { id: field(args, 'p') } } } });
      }
      const i = issues.get(Number(field(args, 'number')));
      if (query.includes('subIssues')) return ok({ data: { repository: { issue: { subIssues: { nodes: [...issues.values()].filter((x) => x.parent === i.number).map((x) => ({ number: x.number, title: x.title })) } } } } });
      if (query.includes('userContentEdits')) return ok({ data: { repository: { issue: { userContentEdits: { nodes: i.edits } } } } });
      return ok({ data: { repository: { issue: { id: `ID_${i.number}`, parent: i.parent ? { number: i.parent } : null } } } });
    }
    return { status: 1, stdout: '', stderr: `fake gh: unsupported ${args.join(' ')}` };
  };
  return state;
}
