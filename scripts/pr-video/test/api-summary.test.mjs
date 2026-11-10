// API summary: route parsing, endpoint diffing against a throwaway git repo, OpenAPI enrichment and
// rendering of the PR's "API changes" section (no test stack or GitHub access).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { API_MARKERS, buildApiSummary, changeScope, changedEndpoints, classifyFiles, parseEndpoints, renderApiSection } from '../lib/api-summary.mjs';
import { removeSection, upsertSection } from '../lib/pr-video.mjs';

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

const API = (extra = '', body = 'return TypedResults.Ok();') => `public static class ItemsApi
{
    public static IEndpointRouteBuilder MapItemsApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("api/items").HasApiVersion(1, 0).HasApiVersion(2, 0);
        var v1 = app.MapGroup("api/items").HasApiVersion(1.0);
        api.MapGet("/{id:int}", GetItem);
        v1.MapGet("/by/{name:minlength(1)}", GetByName);
        api.MapDelete("/{id:int}", DeleteItem);
${extra}        return app;
    }

    public static async Task<IResult> GetItem(int id)
    {
        ${body}
    }

    public static async Task<IResult> GetByName(string name)
    {
        return TypedResults.Ok();
    }

    public static async Task<IResult> DeleteItem(int id)
    {
        return TypedResults.NoContent();
    }
}
`;

test('parseEndpoints joins group prefixes, strips route constraints and keeps API versions', () => {
  const endpoints = parseEndpoints(API());
  assert.deepEqual(endpoints.map((e) => [e.method, e.route, e.versions.join()]), [
    ['GET', '/api/items/{id}', '1.0,2.0'],
    ['GET', '/api/items/by/{name}', '1.0'],
    ['DELETE', '/api/items/{id}', '1.0,2.0'],
  ]);
});

test('changedEndpoints reports added, modified (handler body) and removed endpoints, not untouched ones', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'api-summary-test-'));
  temps.push(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  write(repo, 'src/Items.API/Apis/ItemsApi.cs', API());
  write(repo, 'src/Items.API/Model/Item.cs', 'public record Item(int Id);\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'src/Items.API/Apis/ItemsApi.cs', API('        api.MapPost("/", CreateItem);\n', 'return TypedResults.NotFound();')
    .replace('        api.MapDelete("/{id:int}", DeleteItem);\n', ''));
  sh(repo, 'commit', '-q', '-am', 'change');

  assert.deepEqual(changeScope(repo, 'main'), { frontend: false, backend: true, video: false, api: true });
  const changed = changedEndpoints(repo, 'main').map((e) => `${e.change} ${e.method} ${e.route}`).sort();
  assert.deepEqual(changed, ['added POST /api/items', 'modified GET /api/items/{id}', 'removed DELETE /api/items/{id}']);
});

test('classifyFiles: video only with frontend changes, API summary only with backend-only changes', () => {
  const scope = (...files) => classifyFiles(files);
  assert.deepEqual(scope('src/WebApp/Components/Pages/Cart.razor', 'e2e/teststack/cart.spec.ts'), { frontend: true, backend: false, video: true, api: false });
  assert.deepEqual(scope('src/Ordering.API/Apis/OrdersApi.cs', 'src/Ordering.Domain/Order.cs', 'tests/Ordering.UnitTests/OrderTests.cs', 'docs/x.md'), { frontend: false, backend: true, video: false, api: true });
  assert.deepEqual(scope('src/Catalog.API/Apis/CatalogApi.cs', 'src/WebAppComponents/Catalog/CatalogListItem.razor'), { frontend: true, backend: true, video: true, api: false });
  assert.equal(scope('src/Identity.API/Views/Account/Login.cshtml').frontend, true);
  assert.equal(scope('src/Identity.API/Views/Account/Login.cshtml').backend, false);
  assert.deepEqual(scope('src/eShop.AppHost/Program.cs', 'README.md', 'e2e/teststack/cart.spec.ts'), { frontend: false, backend: false, video: false, api: false });
});

const docs = [{
  url: 'http://localhost:18082/openapi/v1.json',
  doc: {
    info: { version: '1.0' },
    paths: {
      '/api/items': {
        post: {
          summary: 'Create an item',
          parameters: [{ name: 'api-version', in: 'query', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
          responses: { 201: { description: 'Created' }, 400: { description: 'Bad Request', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } } } },
        },
      },
    },
    components: { schemas: { Item: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number', format: 'double' } } } } },
  },
}];

test('the API section documents each changed endpoint from OpenAPI with one recorded example per status', () => {
  const changed = [
    { change: 'added', method: 'POST', route: '/api/items', versions: ['1.0'], service: 'Items.API', file: 'src/Items.API/Apis/ItemsApi.cs', line: 7 },
    { change: 'removed', method: 'DELETE', route: '/api/items/{id}', versions: [], service: 'Items.API', file: 'src/Items.API/Apis/ItemsApi.cs', line: 9 },
  ];
  const known = [{ method: 'GET', route: '/api/items/{id}', versions: ['1.0'], service: 'Items.API', file: 'src/Items.API/Apis/ItemsApi.cs', line: 6 }];
  const call = (method, url, status, extra = {}) => ({ method, url, status, test: 'creates an item', file: 'e2e/teststack/items.spec.ts', ...extra });
  const exchanges = [
    call('POST', 'http://localhost:18082/api/items?api-version=1.0', 201, { requestBody: '{\n  "name": "Rope"\n}', requestHeaders: { authorization: '***' } }),
    call('POST', 'http://localhost:18082/api/items?api-version=1.0', 201),
    call('POST', 'http://localhost:18082/api/items?api-version=1.0', 400, { responseContentType: 'application/problem+json', responseBody: '{ "title": "Bad" }' }),
    call('GET', 'http://localhost:18082/api/items/42?api-version=1.0', 200),
  ];
  const endpoints = buildApiSummary({ changed, known, exchanges, docs });
  assert.deepEqual(endpoints.map((e) => `${e.change} ${e.method} ${e.route} ${e.calls.length}`), [
    'added POST /api/items 3', 'removed DELETE /api/items/{id} 0', 'exercised GET /api/items/{id} 1',
  ]);
  assert.deepEqual(endpoints[0].examples.map((x) => x.status), [201, 400]);

  const section = renderApiSection({ endpoints, headSha: 'abcdef1234', specs: ['e2e/teststack/items.spec.ts'] });
  assert.match(section, /\| 🆕 Added \| `POST` \| `\/api\/items` \| Items\.API \| `Item` \| 201, 400 \| 3 \(201, 400\) \|/);
  assert.match(section, /\*\*Request body:\*\* `application\/json` `Item` \(required\)/);
  assert.match(section, /Fields: `name: string`, `price: number\(double\)`/);
  assert.match(section, /`400` `ProblemDetails` Bad Request/);
  assert.match(section, /```http\nPOST \/api\/items\?api-version=1\.0\nauthorization: \*\*\*\n\n\{\n {2}"name": "Rope"\n\}\n```/);
  assert.doesNotMatch(section, /### `DELETE/, 'removed endpoints are only listed in the table');
  assert.equal(renderApiSection({ endpoints: [] }), null);
});

test('the API section has its own markers, so it coexists with the demo video section and can be removed', () => {
  const withVideo = upsertSection('Story text', 'video');
  const both = upsertSection(withVideo, 'api v1', API_MARKERS);
  assert.equal(upsertSection(both, 'api v2', API_MARKERS), both.replace('api v1', 'api v2'));
  assert.equal(removeSection(both, API_MARKERS), withVideo);
});
