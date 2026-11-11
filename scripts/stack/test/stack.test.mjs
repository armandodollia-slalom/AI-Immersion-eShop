import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  REPO_ROOT, lease, listLeases, loadConfig, parseSlot, poolSize, projectInputs, release, renew, servicesFor,
  shellEnv, slotInfo, slotLoaderConfig, slotPortEnv, slotPorts, staleReason, stripJsonComments, tryLease,
} from '../lib/index.mjs';

const config = loadConfig();
const CLI = path.join(REPO_ROOT, 'scripts/stack/slots.mjs');
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-slots-'));

test('slot 0 keeps the base ports and paths; slot n adds 1000*n everywhere', () => {
  assert.deepEqual(slotPorts(0), Object.fromEntries(Object.entries(config.ports).map(([k, p]) => [k, p.base])));
  const one = slotPorts(1);
  for (const [name, p] of Object.entries(config.ports)) assert.equal(one[name], p.base + 1000);
  assert.equal(slotPorts(8).webapp, 26080);
  assert.equal(slotPortEnv(2).IDENTITY_API_HOST_PORT, '20081');

  assert.deepEqual(
    { ...slotInfo(0), ports: undefined },
    { slot: 0, project: 'eshop-teststack', stateDir: 'artifacts/teststack', envFile: 'artifacts/teststack/.env.teststack',
      loaderConfig: 'testing/teststack.json', imageTag: 'teststack', webappUrl: 'http://localhost:18080',
      identityUrl: 'http://host.docker.internal:18081', dashboardUrl: 'http://localhost:18888', ports: undefined });
  const three = slotInfo('3');
  assert.equal(three.project, 'eshop-teststack-3');
  assert.equal(three.envFile, 'artifacts/teststack/slot-3/.env.teststack');
  assert.equal(three.loaderConfig, 'artifacts/teststack/slot-3/teststack.json');
  assert.equal(three.imageTag, 'teststack-3');
  assert.equal(three.webappUrl, 'http://localhost:21080');
  assert.equal(three.identityUrl, 'http://host.docker.internal:21081');
});

test('slots outside 0..maxSlot and non-integers are rejected', () => {
  for (const bad of [9, -1, '1.5', 'x', '', undefined]) assert.throws(() => parseSlot(bad), /slot/);
  assert.equal(parseSlot(' 8 '), 8);
});

test('no two slots share a host port', () => {
  const seen = new Map();
  for (let slot = 0; slot <= config.maxSlot; slot++) {
    for (const [name, port] of Object.entries(slotPorts(slot))) {
      assert.ok(!seen.has(port), `port ${port} of slot ${slot} ${name} collides with ${seen.get(port)}`);
      seen.set(port, `slot ${slot} ${name}`);
    }
  }
});

test('shell-env lines carry the slot paths, image tag, annotation and every port variable', () => {
  const env = Object.fromEntries(shellEnv(1).split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(env.PROJECT, 'eshop-teststack-1');
  assert.equal(env.IMAGE_TAG, 'teststack-1');
  assert.equal(env.PORT_WEBAPP_HOST_PORT, '19080');
  assert.equal(Object.keys(env).filter(k => k.startsWith('PORT_')).length, Object.keys(config.ports).length);
  const annotation = JSON.parse(`{${env.SLOT_JSON}}`);
  assert.equal(annotation.slot, 1);
  assert.equal(annotation.webappUrl, 'http://localhost:19080');
  assert.equal(annotation.ports.postgres, 19432);
});

test('the loader config is shifted for a slot: project, env file, infrastructure ports and readiness URLs', () => {
  const base = JSON.parse(stripJsonComments(fs.readFileSync(path.join(REPO_ROOT, config.loaderConfig), 'utf8')));
  const slot2 = slotLoaderConfig(base, 2);
  assert.equal(slot2.compose.project, 'eshop-teststack-2');
  assert.equal(slot2.compose.envFile, 'artifacts/teststack/slot-2/.env.teststack');
  assert.equal(slot2.compose.file, base.compose.file);
  assert.equal(slot2.postgres.port, 20432);
  assert.equal(slot2.redis.port, 20379);
  assert.equal(slot2.rabbitMq.port, 20672);
  const webapp = slot2.services.find(s => s.name === 'webapp');
  assert.equal(webapp.url, 'http://localhost:20080/');
  const catalog = slot2.services.find(s => s.name === 'catalog-api');
  assert.equal(catalog.url, 'http://localhost:20082/api/catalog/items?api-version=1.0&pageSize=1');
  assert.deepEqual(slotLoaderConfig(base, 0), base);
});

test('stripJsonComments keeps // inside strings', () => {
  const text = '{\n // comment\n "url": "http://localhost:1/", /* block */ "n": 1,\n}';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { url: 'http://localhost:1/', n: 1 });
});

test('the generated compose file, the AppHost defaults and testing/teststack.json agree with config.json', () => {
  const compose = fs.readFileSync(path.join(REPO_ROOT, 'deploy/teststack/docker-compose.yaml'), 'utf8');
  const used = new Map([...compose.matchAll(/\$\{([A-Z_]+_HOST_PORT):-(\d+)\}/g)].map(m => [m[1], Number(m[2])]));
  const expected = new Map(Object.values(config.ports).map(p => [p.env, p.base]));
  assert.deepEqual(used, expected);
  assert.doesNotMatch(compose, /"\d{5}:/, 'a host port is hard-coded in the compose file');

  const loader = JSON.parse(stripJsonComments(fs.readFileSync(path.join(REPO_ROOT, config.loaderConfig), 'utf8')));
  assert.equal(loader.compose.project, config.project);
  assert.equal(loader.postgres.port, config.ports.postgres.base);
  assert.equal(loader.redis.port, config.ports.redis.base);
  assert.equal(loader.rabbitMq.port, config.ports.rabbitmq.base);
  const bases = new Set(Object.values(config.ports).map(p => p.base));
  for (const s of loader.services.filter(s => s.url)) {
    assert.ok(bases.has(Number(new URL(s.url).port)), `${s.name} probes a port that is not in config.json`);
  }
});

test('services-for maps project folders, shared code and linked files to the services that build them', () => {
  const pick = files => servicesFor(files).services;
  assert.deepEqual(pick(['src/WebApp/Components/Pages/Home.razor']), ['webapp']);
  assert.deepEqual(pick(['src/WebAppComponents/Catalog/CatalogListItem.razor']), ['webapp']);
  assert.deepEqual(pick(['src/Ordering.Domain/AggregatesModel/OrderAggregate/Order.cs']), ['ordering-api']);
  assert.deepEqual(pick(['src/Basket.API/Proto/basket.proto']), ['basket-api', 'webapp']);
  assert.deepEqual(pick(['src/IntegrationEventLogEF/IntegrationEventLogEntry.cs']), ['catalog-api', 'ordering-api', 'webhooks-api', 'promotions-api']);
  // MigrateDbContextExtensions.cs is linked into the services with EF migrations only.
  assert.deepEqual(pick(['src/Shared/MigrateDbContextExtensions.cs']), ['identity-api', 'catalog-api', 'ordering-api', 'webhooks-api', 'promotions-api']);
  const everyService = Object.keys(config.services);
  assert.deepEqual(pick(['src/eShop.ServiceDefaults/Extensions.cs']), everyService);
  assert.deepEqual(pick(['src/EventBus/Abstractions/IEventBus.cs']), everyService.filter(s => !['identity-api', 'webhooksclient'].includes(s)));
  for (const global of ['Directory.Packages.props', 'global.json', 'src/eShop.AppHost/AppHost.cs', 'deploy/teststack/docker-compose.yaml']) {
    const result = servicesFor([global]);
    assert.deepEqual(result.services, everyService, global);
    assert.equal(result.all, true);
  }
  assert.deepEqual(pick(['README.md', 'testing/README.md', 'e2e/teststack/x.spec.ts', 'src/ClientApp/App.xaml', 'tests/Ordering.UnitTests/A.cs']), []);
  assert.deepEqual(pick(['./src\\WebApp\\Program.cs']), ['webapp']);
});

test('projectInputs follows ProjectReference transitively and linked items outside the project', () => {
  const root = tmpHome();
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  write('src/App/App.csproj', '<Project><ItemGroup><ProjectReference Include="..\\Lib\\Lib.csproj" /><Compile Include="..\\Common\\*.cs" /><Protobuf Include="../Api/Proto/api.proto" /></ItemGroup></Project>');
  write('src/Lib/Lib.csproj', '<Project><ItemGroup><ProjectReference Include="..\\Core\\Core.csproj" /><ProjectReference Include="..\\App\\App.csproj" /></ItemGroup></Project>');
  write('src/Core/Core.csproj', '<Project />');
  assert.deepEqual(projectInputs('src/App/App.csproj', { root }).sort(),
    ['src/Api/Proto/api.proto', 'src/App/', 'src/Common/', 'src/Core/', 'src/Lib/']);
  const cfg = { ...config, services: { app: 'src/App/App.csproj', core: 'src/Core/Core.csproj' } };
  assert.deepEqual(servicesFor(['src/Core/X.cs'], { root, config: cfg }).services, ['app', 'core']);
  assert.deepEqual(servicesFor(['src/Common/Y.cs'], { root, config: cfg }).services, ['app']);
});

test('poolSize comes from config and TESTSTACK_SLOTS, capped at maxSlot', () => {
  assert.equal(poolSize(config, {}), config.poolSize);
  assert.equal(poolSize(config, { TESTSTACK_SLOTS: '4' }), 4);
  assert.equal(poolSize(config, { TESTSTACK_SLOTS: '50' }), config.maxSlot);
  assert.throws(() => poolSize(config, { TESTSTACK_SLOTS: 'two' }), /TESTSTACK_SLOTS/);
});

test('leases hand out slots 1..pool once each, then null; release frees a slot', async () => {
  const home = tmpHome();
  const opts = { home, pool: 2 };
  const a = await tryLease('a', opts);
  const b = await tryLease('b', opts);
  assert.deepEqual([a.slot, b.slot], [1, 2]);
  assert.equal(a.webappUrl, 'http://localhost:19080');
  assert.equal(await tryLease('c', opts), null);
  await assert.rejects(release(1, { home, owner: 'b' }), /leased by 'a'/);
  assert.equal((await release(1, { home, owner: 'a' })).owner, 'a');
  assert.equal((await tryLease('c', opts)).slot, 1);
  const listed = listLeases(opts);
  assert.deepEqual(listed.map(s => [s.slot, s.free, s.lease?.owner]), [[1, false, 'c'], [2, false, 'b']]);
  assert.equal(await release(2, { home, owner: 'nobody', force: true }).then(l => l.owner), 'b');
  assert.equal(await release(2, { home }), null);
});

test('concurrent leases never share a slot (in-process and across processes)', async () => {
  const home = tmpHome();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => tryLease(`p${i}`, { home, pool: 3 })));
  const slots = results.filter(Boolean).map(r => r.slot).sort();
  assert.deepEqual(slots, [1, 2, 3]);

  const home2 = tmpHome();
  const runs = Array.from({ length: 8 }, (_, i) => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'lease', '--owner', `proc${i}`, '--pid', String(process.pid)], {
      env: { ...process.env, TESTSTACK_STATE_HOME: home2, TESTSTACK_SLOTS: '3', TESTSTACK_DOCKER: 'false' },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, result: JSON.parse(out) }));
  }));
  const done = await Promise.all(runs);
  const won = done.filter(r => r.result.ok).map(r => r.result.slot).sort();
  assert.deepEqual(won, [1, 2, 3]);
  assert.ok(done.filter(r => !r.result.ok).every(r => r.code === 2));
});

test('stale leases (owner gone or past the TTL) are recovered; fresh or unwritten ones are not', async () => {
  const home = tmpHome();
  const dir = path.join(home, 'leases');
  fs.mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  fs.writeFileSync(path.join(dir, 'slot-1.json'), JSON.stringify({ slot: 1, owner: 'ghost', pid: deadPid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, 'slot-2.json'), JSON.stringify({ slot: 2, owner: 'live', pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
  const listed = listLeases({ home, pool: 2 });
  assert.match(listed[0].stale, /is gone/);
  assert.equal(listed[1].stale, null);
  const claimed = await tryLease('new', { home, pool: 2 });
  assert.equal(claimed.slot, 1);
  assert.match(claimed.recovered, /is gone/);
  assert.equal(await tryLease('another', { home, pool: 2 }), null);

  // Past the TTL even though the owner is alive.
  const later = Date.now() + 5 * 60_000;
  const viaTtl = await tryLease('ttl', { home, pool: 2, ttlMs: 60_000, now: () => later });
  assert.ok(viaTtl);
  assert.match(viaTtl.recovered, /older than 1 min/);

  // A lease file being written right now (unparseable, young) is respected; an old one is not.
  assert.equal(staleReason({ unreadable: true, ageMs: 1000 }, { ttlMs: 1e9 }), null);
  assert.match(staleReason({ unreadable: true, ageMs: 60_000 }, { ttlMs: 1e9 }), /unreadable/);
  // Leases from another host are only aged out by the TTL.
  assert.equal(staleReason({ pid: deadPid, hostname: 'elsewhere', createdAt: new Date().toISOString() }, { ttlMs: 1e9 }), null);
});

test('renew refreshes the TTL clock; lease waits for a slot to be released', async () => {
  const home = tmpHome();
  const first = await tryLease('holder', { home, pool: 1 });
  const t0 = Date.now();
  const renewed = await renew(first.slot, { home, owner: 'holder', now: () => t0 + 50 * 60_000 });
  assert.equal(staleReason(renewed, { now: t0 + 90 * 60_000, ttlMs: 60 * 60_000 }), null);
  await assert.rejects(renew(1, { home, owner: 'other' }), /leased by 'holder'/);

  setTimeout(() => { release(1, { home }); }, 150);
  const started = Date.now();
  const waited = await lease('waiter', { home, pool: 1, waitSec: 5, pollMs: 50 });
  assert.equal(waited.slot, 1);
  assert.ok(Date.now() - started >= 100);
  assert.equal(await lease('impatient', { home, pool: 1, waitSec: 0 }), null);
});

test('the CLI prints one JSON line for lease, list and release', () => {
  const home = tmpHome();
  const env = { ...process.env, TESTSTACK_STATE_HOME: home, TESTSTACK_SLOTS: '1', TESTSTACK_DOCKER: 'false' };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  const ok = run('lease', '--owner', 'cli', '--pid', String(process.pid));
  assert.equal(ok.status, 0, ok.stderr);
  const leased = JSON.parse(ok.stdout);
  assert.equal(leased.slot, 1);
  assert.equal(leased.webappUrl, 'http://localhost:19080');
  assert.equal(leased.ports.identity, 19081);
  const full = run('lease', '--owner', 'cli2');
  assert.equal(full.status, 2);
  assert.equal(JSON.parse(full.stdout).ok, false);
  assert.equal(JSON.parse(run('list').stdout).slots[0].lease.owner, 'cli');
  assert.equal(JSON.parse(run('release', '--slot', '1').stdout).released, true);
  const bad = run('info', '--slot', '12');
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.equal(run('nope').status, 64);
});
