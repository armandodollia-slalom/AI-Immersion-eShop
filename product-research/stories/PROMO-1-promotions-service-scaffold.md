# PROMO-1: [BE - Promotions.API, eShop.AppHost, Identity.API] - Promotions service scaffold

**User Story:**

As a developer, I want a `Promotions.API` service with its own database, event bus connection and auth, running under Aspire, so that promotion data lives in its own bounded context and other teams can build on it from Day 1.

**Inputs:**

- New project `src/Promotions.API` (ASP.NET Core minimal API) that references `eShop.ServiceDefaults`, `EventBusRabbitMQ` and `IntegrationEventLogEF`, and is added to `eShop.slnx`
- AppHost registration, following the existing `AddDotnetProject` pattern:
  ```csharp
  var promotionsDb = postgres.AddDatabase("promotionsdb");

  var promotionsApi = builder.AddDotnetProject("promotions-api", "../Promotions.API")
      .WithReference(rabbitMq).WaitFor(rabbitMq)
      .WithReference(promotionsDb).WaitFor(promotionsDb)
      .WithHttpHealthCheck("/health")
      .WithEnvironment("Identity__Url", identityEndpoint);

  webApp.WithReference(promotionsApi);
  orderingApi.WithReference(promotionsApi);
  ```
- Identity: a new API resource and scope named `promotions`, added to the `webapp` client's allowed scopes
- `appsettings.json`:
  ```json
  {
    "Identity": { "Audience": "promotions" },
    "EventBus": { "SubscriptionClientName": "Promotions" }
  }
  ```

**Outputs:**

All endpoints are versioned like the other services: callers pass `?api-version=1.0`.

- `promotions-api` and `promotionsdb` show as healthy in the Aspire dashboard, and `/health` and `/alive` (from `MapDefaultEndpoints`) return `200` when the database is reachable.
- On startup, the EF migration creates the tables `Promotions`, `PromotionTargets`, `Coupons`, `CouponRedemptions` and `IntegrationEventLog`.
- On first run, the seeder inserts exactly 4 promotions and 2 coupons:

  | Name | Rule type | Coupon only | Status | Window |
  | --- | --- | --- | --- | --- |
  | a percent-off promotion | `PercentOff` | no | `Published` | starts 1 day before the first run, ends 60 or more days after it |
  | an amount-off-order promotion | `AmountOffOrder` | no | `Published` | same |
  | a buy-X-get-Y promotion | `BuyXGetY` | no | `Published` | same |
  | a coupon-only promotion | `PercentOff` | yes (`RequiresCoupon = true`) | `Published` | same |

  The coupons `FALL10` and `WELCOME5` both belong to the coupon-only promotion and have no redemptions. If the `Promotions` table already has any row, the seeder inserts nothing.
- **Active promotion** means `Status = Published` and `StartsAt <= now < EndsAt`, where "now" is the server clock (`TimeProvider`). Coupon-only promotions count as active.
- `GET /api/promotions/active` allows anonymous access, ignores any bearer token sent with it, and returns `200` with a JSON array of the active promotions ordered by `priority` descending, then `id` ascending. Each element has at least `id`, `name`, `type`, `status`, `startsAt`, `endsAt`, `priority` and `requiresCoupon`. When no promotion is active it returns `200` with `[]`. The final response shape is [PROMO-2](PROMO-2-promotion-rule-model-and-admin-api.md)'s.
- `GET /api/promotions` is a temporary authenticated endpoint (PROMO-2 replaces it with the admin API). With a valid access token that has the `promotions` scope it returns `200` with every promotion, active or not. Without a token, or with a malformed or expired token, it returns `401`.
- Identity has an API resource and an API scope both named `promotions`, and `promotions` is in the `webapp` client's allowed scopes only. The WebApp requests the `promotions` scope at sign-in.

**Acceptance Criteria:**

* **Given** the AppHost
* **When** its resource model is built
    * **Then** `promotions-api` references and waits for `eventbus` and `promotionsdb`, has an HTTP health check on `/health` and gets `Identity__Url`, and `webapp` and `ordering-api` reference `promotions-api`
* **Given** an empty `promotionsdb`
* **When** Promotions.API starts
    * **Then** the five tables exist and the seed data matches the table above
* **When** Promotions.API starts again against the same database
    * **Then** there are still exactly 4 promotions and 2 coupons
* **Given** the seeded promotions plus one `Draft` promotion, one that ended yesterday and one that starts tomorrow
* **When** `GET /api/promotions/active` is called anonymously
    * **Then** it returns `200` with exactly the 4 seeded promotions in the stated order, and none of the other three
* **When** it is called with a malformed bearer token
    * **Then** it still returns `200` with the same promotions
* **When** a user signs in to the WebApp
    * **Then** the access token's `scope` claim includes `promotions`, and `GET /api/promotions` with that token returns `200` with every promotion
* **When** `GET /api/promotions` is called without a token, or with a malformed or expired token
    * **Then** it returns `401`

**Test scope:**

* **AppHost wiring** is checked on the resource model in `tests/eShop.AppHost.UnitTests`, not by timing a running stack. Startup order is what `WaitFor` guarantees; don't measure it.
* **Migration and seeding** are checked at the functional layer (`tests/Promotions.FunctionalTests`, real Postgres, seeding on), because the test stack runs every service with `Seeding__Disabled=true`. Test stack scenarios load their own promotions data.
* **Endpoints and tokens** are checked at the functional or test-stack layer. Use the test stack users (alice and bob) for the WebApp sign-in case.
* **Out of scope:** rejecting a token issued for another audience. `AddDefaultAuthentication` doesn't validate the audience in any service yet; that's tracked as [BUG-6](BUG-6-basket-token-without-scope-accepted.md). Also out of scope: concurrent seeding by two instances, recovery after a database outage, and the exact `WWW-Authenticate` header or response body of a `401`.

**Technical Notes:**

* **Interaction history:** This story is PROMO-1 from the [promotions & recommendations epic](epic-promotions-and-recommendations.md). The epic's AppHost snippet used `AddProject<Projects.Promotions_API>`; this repo actually uses `builder.AddDotnetProject(name, path)`, so the snippet above follows the real pattern. We agreed promotions get their own service (not a module inside Catalog.API or Basket.API) so that teams can work in parallel during the workshop.
* **Existing code to reuse:**
    * `src/Webhooks.API/Program.cs:1-24` and `src/Webhooks.API/Extensions/Extensions.cs:3-24`: the smallest existing template with service defaults, auth, RabbitMQ, Npgsql, `AddMigration` and event subscriptions all in one place. Copy its structure.
    * `src/eShop.AppHost/AppHost.cs:17-20`: where the databases are declared.
    * `src/eShop.AppHost/AppHost.cs:42-46,56-59`: project registrations to copy, with health check and `Identity__Url`.
    * `src/eShop.AppHost/AppHost.cs:71-79`: the `webApp` references.
    * `src/Shared/MigrateDbContextExtensions.cs:25-27`: `AddMigration<TContext, TDbSeeder>()` with `IDbSeeder<TContext>`. The seeder pattern is in `src/Catalog.API/Infrastructure/CatalogContextSeed.cs:11`, and it's registered at `src/Catalog.API/Extensions/Extensions.cs:24`.
    * `src/Identity.API/Configuration/Config.cs:10-12,22-24`: where `ApiResource` and `ApiScope` are added.
    * `src/Identity.API/Configuration/Config.cs:78`: the `webapp` client, whose `AllowedScopes` gets `promotions`.
    * `src/eShop.ServiceDefaults`: `AddDefaultAuthentication()` reads `Identity:Audience`.
* **New code (proposal):**
    * a `PromotionsContext` (EF Core) and a `PromotionsContextSeed`
    * the `Promotions.API` project files
    * an `Apis/PromotionsApi.cs` stub that maps the `/api/promotions` group
    * The entity shapes come from [PROMO-2](PROMO-2-promotion-rule-model-and-admin-api.md) and [PROMO-4](PROMO-4-coupon-codes-and-redemption.md). This story only needs enough of them for the migration to run.

**Related Stories:**

* **Part of:** [Promotions & Recommendations epic](epic-promotions-and-recommendations.md)
* **Blocks:** [PROMO-2](PROMO-2-promotion-rule-model-and-admin-api.md), [PROMO-3](PROMO-3-cart-pricing-evaluation-api.md), [PROMO-4](PROMO-4-coupon-codes-and-redemption.md)

**Open Questions:**

* None. Decided: Promotions.API is not added to the `mobile-bff` YARP routes yet, and the `promotions` scope goes only to the `webapp` client. Revisit both when a mobile client needs promotions.
