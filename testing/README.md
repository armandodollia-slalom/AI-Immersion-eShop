# eShop test stack

A reproducible Docker Compose deployment of the whole app. You put it into a known state from a **scenario file** that seeds the databases and Redis directly. It is built for agents and automated tests: every command blocks until the stack is healthy and prints one JSON result line.

Aspire (`aspire start`) remains the day-to-day dev loop. Use this stack for scenario-driven test runs.

## Quick start

```bash
testing/teststack up                          # build images if sources changed, start, wait, load "default"
testing/teststack load order-history          # clear everything and load another scenario (~0.6 s; ~2 s if ordering-api must restart)
testing/teststack reset                       # clear everything, base lookup data only
npx playwright test -c playwright.teststack.config.ts
testing/teststack down                        # remove containers and all data
```

Requires Docker (or a compatible engine via `TESTSTACK_DOCKER`), the .NET SDK, and the Aspire CLI (`scripts/setup.sh` installs them).

## How the stack is produced

| Piece | Source |
| --- | --- |
| `deploy/teststack/docker-compose.yaml`, `.env` | **Generated** by `testing/teststack publish` (`TestStack=true aspire publish`). Never edit them by hand. |
| Compose customizations (ports, HTTP-only, seeder switch, identity URL) | C# in `src/eShop.AppHost/TestStack.cs`, enabled by `TestStack=true` in `AppHost.cs` |
| Host port table and slot math | `scripts/stack/config.json` (`ports`), used by `testing/teststack` and `scripts/stack/slots.mjs`. A test checks that the generated compose file and `testing/teststack.json` agree with it. |
| Service images | `aspire do prepare-teststack`, which uses the same `dotnet publish` container build as production |
| Resolved image tags, ports, test passwords | `artifacts/teststack/.env.teststack` (generated, git-ignored) |

The only test-only differences from production are:

- **The seeder switch.** `Seeding__Disabled=true` makes `MigrateDbContextExtensions` skip `CatalogContextSeed`, `UsersSeed` and `OrderingContextSeed`. EF migrations still run at service startup, so the services own the schema.
- **The scenario loader** (this folder).

CI runs `testing/teststack publish --check`, which regenerates the files and fails if they differ from the committed ones. After changing the AppHost, run `testing/teststack publish` and commit the result.

`build` (which `up` runs for you) hashes `src/` plus the build props. It rebuilds the images only when that hash changes or an image is missing. Use `--force` to rebuild anyway. A full build takes about 1.5 minutes, and `up` from built images takes about 35 s.

Images are built for the host's Linux architecture (arm64 on Apple silicon), so they run without emulation. Production publishing still targets linux-amd64. Set `TestStackPlatform=linux-amd64` (or `linux-arm64`) to override. Images get a stable local tag per slot: `<service>:teststack` for slot 0 and `<service>:teststack-<n>` for slot n. The build itself tags `<service>:latest` before retagging, so image builds are serialized machine-wide through a lock in `~/.eshop-teststack/build.lock` (a second build waits for the first).

On macOS without Docker Desktop, [colima](https://github.com/abiosoft/colima) works: `brew install colima docker docker-compose`, then `colima start --cpu 8 --memory 16 --vm-type vz --mount-type virtiofs`. `host.docker.internal` resolves inside containers with both.

## Commands

| Command | Description |
| --- | --- |
| `up [--scenario <name\|path>] [--timeout s]` | Build if needed, `compose up -d`, wait, then load the scenario (default: `default`). |
| `down` | `compose down -v`: removes containers and all data. |
| `build [--force]` | Build the images and the loader, only when needed. |
| `load <name\|path> [--hard] [--timeout s]` | Clear all state, then load `_base`, then the scenario's `extends` chain, then the scenario itself. |
| `reset [--hard] [--timeout s]` | Same as `load` with only `_base`. |
| `wait [--timeout s]` | Block until the stack is ready (default timeout: 300 s). |
| `status` | One readiness pass, without waiting. |
| `validate [<name\|path>...]` | Parse and resolve scenarios (all by default). Needs no running stack. |
| `hash-password <pw>` | Print an ASP.NET Identity V3 hash for `AspNetUsers.PasswordHash`. |
| `rebuild-changed --base <ref>` | Rebuild only the images affected by `git diff <ref>...HEAD` plus uncommitted and untracked files, recreate only those containers if the stack is running, then `wait`. `--services a,b` names services instead of (or on top of) a diff. See [Slots](#slots-parallel-stacks). |
| `services-for <files...>` | Print the compose services whose images those files affect (pure mapping, no Docker). |
| `publish [--check]` | Regenerate `deploy/teststack`. `--check` fails on drift. |
| `logs [svc...]`, `compose <args>` | Run `docker compose` against the stack. |

**Output contract:** logs go to stderr, and stdout gets exactly one JSON line, for example:

```json
{"ok":true,"command":"load","scenario":"order-history","layers":["_base","default","order-history"],"mode":"soft","purgedMessages":0,"restarted":["ordering-api"],"elapsedMs":1840}
```

`up`, `load`, `reset`, `wait`, `status`, `build`, `down` and `rebuild-changed` also carry the slot: `"slot"`, `"project"`, `"webappUrl"`, `"identityUrl"` and `"ports"` (see [Slots](#slots-parallel-stacks)). When `ok` is false, the line also contains `error` (and `slot`). `status` and `wait` failures list the checks that are not ready.

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Error |
| 2 | Not ready (timeout) |
| 3 | Invalid scenario |
| 64 | Usage error |

### Readiness

A service counts as ready when all of the following hold:

- Its container is running.
- Postgres, Redis and RabbitMQ answer.
- Its HTTP probe answers. The services run as Production, where `/health` is not mapped. Kestrel only starts listening once migrations finish, so any response below 500 means migrations are done. Basket uses an h2c probe.
- Its database has an `__EFMigrationsHistory` table.
- Each of its RabbitMQ queues exists and has at least one consumer.

A service that stays unready for 60 s while the infrastructure is healthy is restarted once. This covers the event bus, which never reconnects if its first connection fails.

## Reset semantics

**Soft (default)** takes about 0.6 s, or about 2 s when `ordering-api` has to restart (see below). It never touches `__EFMigrationsHistory`. In order, it:

1. Purges the RabbitMQ queues.
2. Truncates every table in every database except `__EFMigrationsHistory` (`RESTART IDENTITY CASCADE`). This includes the outbox and `IntegrationEventLog` tables.
3. Flushes Redis.
4. Purges the queues again.
5. Loads the scenario layers, one transaction per database.
6. Moves every identity and HiLo sequence to `MAX(Id)+1`.

Ordering.API caches HiLo ID blocks in memory. If any of its HiLo sequences has been used since the last load, the reset restarts `ordering-api`, so new orders never collide with seeded IDs. That restart is reported in `restarted`.

**Hard (`--hard`)** takes about 4-7 s. It stops the app services and recreates each database from `<db>__template`, a snapshot taken right after migrations ran on empty databases. It then flushes Redis, purges the queues, restarts the services and loads the scenario. Templates are created on first use and rebuilt when the migration history changes. Use hard mode when a test changed the schema or left state outside tables.

## Scenario files

Scenarios live in `testing/scenarios/<name>/scenario.yaml`. JSON also works, and you can pass any path instead of a name.

```yaml
description: Alice has one shipped order and a basket.
extends: default                     # optional; a name, a path, or a list. Applied before this file.
postgres:
  orderingdb:                        # catalogdb | identitydb | orderingdb | webhooksdb
    - sql: orders.sql                # a raw SQL file, relative to this file
    - table: ordering.buyers         # or "Table" for the public schema
      rows:                          # inline rows; or rowsFile: buyers.json|yaml
        - { Id: 1, IdentityGuid: a11ce000-0000-4000-8000-000000000001, Name: Alice }
redis:
  - key: /basket/a11ce000-0000-4000-8000-000000000001
    json: { BuyerId: a11ce000-0000-4000-8000-000000000001, Items: [] }   # or value: "raw"; ttl: seconds
```

Rows are inserted with `json_populate_recordset`, so column names must match the database exactly (EF uses PascalCase). Columns you leave out get their database defaults. Use explicit IDs; sequences are fixed up afterwards. YAML plain scalars that look like JSON numbers become numbers; quote values like `"98052"` to keep them as strings. Unknown keys, databases or files cause exit code 3.

### Included scenarios

| Scenario | Contents |
| --- | --- |
| `_base` | Lookup data, always loaded first: `ordering.cardtypes` (1 Amex, 2 Visa, 3 MasterCard). |
| `empty` | Base only. |
| `default` | What the built-in seeders used to produce: 101 catalog items, 13 brands, 8 types, plus users `alice` and `bob` (password `Pass123$`). |
| `order-history` | `default` plus alice as a buyer, with a Visa payment method, a Shipped order, a Cancelled order and two basket items. |
| `catalog-edge` | Its own 14-item "Edge" catalog over 2 pages: a zero-stock item, a 50-character name, prices $0.01 and $9,999.99, an empty description, and a brand and a type with no items. Plus alice and bob. |
| `catalog-pictures` | `catalog-edge` plus item 15 with no picture file, item 16 whose picture file does not exist, and item 17 "Edge 17 100% Wool_Sock" (SQL `LIKE` wildcards in the name). Used by `e2e/teststack/catalog-api.spec.ts`. |
| `order-lifecycle` | `default` plus bob with a Visa and six orders, one per `OrderStatus`. The past-dated Submitted order is advanced to Paid by the background services within about 30 s of loading. alice has no orders. |
| `returning-customers` | `default` plus carol (`c0001000-0000-4000-8000-000000000003`, password `Carol#2026`) with a Visa, a Seattle address and a 3-item basket, and a basket for bob whose stored price is stale (the cart shows the catalog price). |
| `auth-lockout` | `default` plus lockout users (password `Pass123$`): dave locked until 2099, erin one failure from lockout, gina with an expired lockout, frank with lockout disabled. |
| `basket-edge` | `default` plus baskets: bob with 2 lines, quinn with 120 units (badge shows 99+), oscar with a line for a product no longer in the catalog. |
| `ordering-two-buyers` | `default` plus alice with orders 1-6 (statuses the pipeline leaves alone) and a basket, and bob with a Paid order 7 and a Shipped order 8. |
| `ordering-stock` | `default` with low stock plus four past-dated Submitted orders for bob; within about 30 s two reach Paid and two are cancelled by the stock check. |
| `webhooks-subscriptions` | `default` plus webhook subscriptions for alice (OrderPaid, OrderShipped) and bob (CatalogItemPriceChange), and an alice order that reaches Paid shortly after loading. |

Fixed user IDs:

| User | ID |
| --- | --- |
| alice | `a11ce000-0000-4000-8000-000000000001` |
| bob | `b0b00000-0000-4000-8000-000000000002` |

The flows these scenarios exercise, with their positive and negative cases, known app bugs and covering tests, are mapped in `testing/flows/` ([catalog](flows/catalog.md), [identity and basket](flows/identity-basket.md), [ordering and webhooks](flows/ordering.md)). Tests that assert correct behavior the app does not have yet are marked `test.fixme` and listed in those files.

Scenario specs live in `e2e/teststack/`. The spec loads its scenario in `beforeAll` with `loadScenario()` from `e2e/teststack/scenario.ts`, and runs in the `scenarios` project of `playwright.teststack.config.ts`, after the standard suite.

The user ID is also the Redis basket key suffix (`/basket/<id>`) and `ordering.buyers.IdentityGuid`. Passwords are stored pre-hashed; generate new hashes with `testing/teststack hash-password '<pw>'`. Basket JSON matches `CustomerBasket` (`BuyerId`, `Items[]` with `Id`, `ProductId`, `ProductName`, `UnitPrice`, `OldUnitPrice`, `Quantity`, `PictureUrl`).

AI features (embeddings, chat) are off in this stack, so `Catalog.Embedding` stays null.

## Ports and URLs (HTTP only)

These are slot 0's ports. Slot n adds 1000 × n to every one of them (slot 1: webapp 19080, identity 19081, ...).

| Service | Port |
| --- | --- |
| WebApp | 18080 |
| Identity | 18081 |
| Catalog | 18082 |
| Basket (gRPC) | 18083 |
| Ordering | 18084 |
| Webhooks API | 18085 |
| Webhooks client | 18086 |
| Mobile BFF | 18087 |
| Dashboard | 18888 |
| Postgres | 18432 |
| Redis | 18379 |
| RabbitMQ | 18672 |

The test credentials are in `testing/teststack` (`postgres` / `teststack-postgres`, and so on).

Identity is published as `http://host.docker.internal:18081` (slot n: `18081 + 1000n`), so the browser and the containers use the same issuer URL:

- `playwright.teststack.config.ts` maps that host to 127.0.0.1 for you.
- To log in from a normal browser, add `127.0.0.1 host.docker.internal` to `/etc/hosts`. Docker Desktop usually adds this already.

## Slots (parallel stacks)

Several isolated copies of the stack can run on one machine, for example one per agent worktree. Each copy is a **slot**:

| | Slot 0 (default) | Slot n (1..8) |
| --- | --- | --- |
| Select | nothing, or `--slot 0` | `testing/teststack --slot <n> <command>` or `TESTSTACK_SLOT=<n>` |
| Compose project | `eshop-teststack` | `eshop-teststack-<n>` |
| Host ports | the table above | every port + 1000 × n |
| State (env file, stamps, loader config) | `artifacts/teststack/` | `artifacts/teststack/slot-<n>/` (with its own generated `teststack.json`) |
| Images | `<service>:teststack` | `<service>:teststack-<n>` |
| Identity URLs | `http://host.docker.internal:18081`, clients `http://localhost:18080` / `:18086` | the same, on the slot's ports |

Slot 0 behaves exactly as before. The compose file publishes every host port and browser-facing URL as `${WEBAPP_HOST_PORT:-18080}`-style variables (from `TestStack.cs`); `testing/teststack` exports the slot's values, so Identity's client redirect URIs, the issuer and the callbacks all follow the slot. With the defaults, slot 0 resolves to the same configuration as before.

**Leasing.** Slot 0 is reserved for people and the existing QE flows. Agents lease slots 1..`poolSize` (`scripts/stack/config.json`, default 2, overridden by `TESTSTACK_SLOTS`):

```bash
node scripts/stack/slots.mjs lease --owner implement:PROMO-3 --wait-sec 600 [--pid <owner pid>]
# {"ok":true,"slot":1,"owner":"implement:PROMO-3","project":"eshop-teststack-1","webappUrl":"http://localhost:19080",
#  "identityUrl":"http://host.docker.internal:19081","dashboardUrl":"http://localhost:19888","ports":{"webapp":19080,...},...}
testing/teststack --slot 1 up --scenario default
TESTSTACK_URL=http://localhost:19080 npx playwright test -c playwright.teststack.config.ts ...
testing/teststack --slot 1 down
node scripts/stack/slots.mjs release --slot 1 --owner implement:PROMO-3
node scripts/stack/slots.mjs list            # every pool slot, its owner and whether the lease is stale
```

- When no slot is free, `lease` polls until `--wait-sec` runs out, then prints `{"ok":false,...}` and exits 2.
- Leases live machine-wide in `~/.eshop-teststack/leases/` (override with `TESTSTACK_STATE_HOME`), because they are taken from different worktrees and ports are machine-wide. Claims are serialized by an atomic `mkdir` mutex and each lease file is created with `O_EXCL`.
- A lease is stale, and the next `lease` takes it over, when its owner pid is gone or it is older than `leaseTtlMinutes` (240) since it was taken or last renewed (`slots.mjs renew --slot <n>`). The owner pid defaults to the parent process of `slots.mjs` (the harness that spawned it); pass `--pid` when that is a short-lived shell.
- `release` does not stop the stack. Run `down` first unless the next owner should reuse it.
- `lease` warns (stderr and `warning`) when Docker's memory looks too small for one more stack.
- The QE stage runs a story's e2e specs on a leased slot when several tickets are implemented at once ([qe.md](../docs/ai-pipeline/qe.md#stack-slots)). Specs reach the slot through `e2e/teststack/ports.ts` (URLs from `TESTSTACK_SLOT`); specs with literal 18xxx ports stay on slot 0.
- The harness can import everything from `scripts/stack/lib/index.mjs` (`lease`, `release`, `renew`, `listLeases`, `slotInfo`, `slotPorts`, `servicesFor`, ...).

**Incremental rebuilds.** After code changes in a worktree, rebuild only what changed:

```bash
testing/teststack --slot 1 rebuild-changed --base main
# {"ok":true,"command":"rebuild-changed","base":"main","changedFiles":7,"services":["ordering-api","webapp"],"full":false,
#  "recreated":["ordering-api","webapp"],"wait":{...},"elapsedMs":41000,"slot":1,...}
testing/teststack services-for src/Shared/MigrateDbContextExtensions.cs   # -> identity-api, catalog-api, ordering-api, webhooks-api
```

The mapping walks each service project's MSBuild references: a file under a project folder selects that service; shared projects (`EventBus`, `EventBusRabbitMQ`, `IntegrationEventLogEF`, `eShop.ServiceDefaults`, `WebAppComponents`, `Ordering.Domain`, ...) select every service that references them; files linked from outside (`src/Shared/*.cs`, Basket's `basket.proto` in WebApp) select the projects that link them. `Directory.*.props`, `global.json`, `nuget.config`, the AppHost and `deploy/teststack` select every service. Each affected image is built with `aspire do build-<service>` and retagged for the slot, then only those containers are recreated (`compose up -d --no-deps`).

`rebuild-changed` builds everything (`"full":true`) instead when the slot's images were not built from this worktree (another worktree used the slot since, which `artifacts/teststack/slot-<n>/images.ids` detects) or when every service is affected anyway. A rebuild trusts the diff: a change that was made and then reverted after the last build is not seen, so run `build --force` if in doubt.

**Memory.** A stack is 14 containers (Postgres, Redis, RabbitMQ, the dashboard, 9 .NET services and the YARP mobile BFF). Measured with `docker stats` on Apple silicon: about 0.95 GB right after `up`, about 1.55 GB after a few hours of tests. Budget about 2 GB per slot (`stackMemoryMb` in `scripts/stack/config.json`); two slots plus slot 0 fit in a 16 GB Docker VM. Each slot has its own tags of the 9 service images (about 3.5 GB in `docker images`, mostly shared base layers); remove them with `docker image rm $(docker images --format '{{.Repository}}:{{.Tag}}' | grep ':teststack-<n>$')`.

## Agent workflow

```bash
testing/teststack up --scenario order-history || exit $?   # first run builds the images; later runs reuse them
# ...run tests / probe http://localhost:18080 ...
testing/teststack load default                             # fast reset between tests
testing/teststack status                                   # JSON readiness report when something looks wrong
testing/teststack logs ordering-api
```

To write a new scenario:

1. Copy one from `testing/scenarios/`.
2. Run `testing/teststack validate <path>`.
3. Run `testing/teststack load <path>`.

## Test videos

Every Playwright e2e test is recorded, but by default only failed tests keep their video and keyframes: `artifacts/e2e-videos/<project>/<spec>--<test>.failed.webm`, also in the HTML report. Set `E2E_KEEP_VIDEOS=1` to keep passing tests' videos (`<spec>--<test>.webm`) too. Specs import `test` from `e2e/fixtures.ts`, which also records contexts a test opens itself with `browser.newContext()`; contexts from `beforeAll` and API-only tests have no video. Use the `demo` fixture from `e2e/demo.ts` to add chapter cards, captions and highlights; `e2e/teststack/add-to-cart.spec.ts` is an example. See `.github/skills/feature-demo-video/SKILL.md`.
