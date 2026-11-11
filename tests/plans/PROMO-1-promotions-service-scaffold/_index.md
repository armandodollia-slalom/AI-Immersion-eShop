---
story: PROMO-1
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/52"
story-sha: e899d5ef9a7c
plan-sha: 509d55bc6934
verified-score: 9
verified-at: "2026-11-11T15:41:26.760Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: afd3b90f8691
automation-plan-sha: 509d55bc6934
automation-score: 9
automation-verified-at: "2026-11-11T16:32:26.040Z"
---
# Test plan: PROMO-1 [BE - Promotions.API, eShop.AppHost, Identity.API] - Promotions service scaffold

This plan covers the Promotions.API scaffold: AppHost wiring (unit, on the resource model), migration and seeding (functional, real Postgres, seeding on), the anonymous `GET /api/promotions/active` and authenticated `GET /api/promotions` endpoints, health endpoints, and the Identity `promotions` resource and scope with the WebApp sign-in (e2e on the test stack). All requests pass `?api-version=1.0`.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-PROMO-1-01 | promotions-api references and waits for eventbus and promotionsdb | happy | unit | AC: AppHost resource model; Inputs: AppHost registration WithReference/WaitFor |
| TC-PROMO-1-02 | promotions-api has an HTTP health check on /health | happy | unit | AC: AppHost resource model; Inputs: WithHttpHealthCheck("/health") |
| TC-PROMO-1-03 | promotions-api gets the Identity__Url environment variable | happy | unit | AC: AppHost resource model; Inputs: WithEnvironment("Identity__Url", identityEndpoint) |
| TC-PROMO-1-04 | webapp and ordering-api reference promotions-api | happy | unit | AC: AppHost resource model; Inputs: webApp.WithReference(promotionsApi); orderingApi.WithReference(promotionsApi) |
| TC-PROMO-1-05 | Startup migration creates the five tables on an empty database | happy | functional | Outputs: EF migration creates tables; AC: five tables exist |
| TC-PROMO-1-06 | Seeder inserts exactly the four seeded promotions | happy | functional | Outputs: seeder inserts exactly 4 promotions; AC: seed data matches the table |
| TC-PROMO-1-07 | Seeder inserts coupons FALL10 and WELCOME5 on the coupon-only promotion | happy | functional | Outputs: 2 coupons FALL10 and WELCOME5; Outputs: no redemptions |
| TC-PROMO-1-08 | Restarting against the same database keeps 4 promotions and 2 coupons | happy | functional | AC: starts again against the same database; Outputs: seeder idempotent |
| TC-PROMO-1-09 | Seeder inserts nothing when Promotions already has a row | sad | functional | Outputs: if the Promotions table already has any row, the seeder inserts nothing |
| TC-PROMO-1-10 | /health and /alive return 200 when the database is reachable | happy | functional | Outputs: /health and /alive return 200 |
| TC-PROMO-1-11 | GET /active returns the four seeded promotions and no inactive ones | happy | functional | Outputs: active promotion definition; Outputs: coupon-only promotions count as active; AC: exactly the 4 seeded promotions |
| TC-PROMO-1-12 | GET /active orders promotions by priority descending | happy | functional | Outputs: ordered by priority descending |
| TC-PROMO-1-13 | Promotions with equal priority are ordered by id ascending | happy | functional | Outputs: then id ascending |
| TC-PROMO-1-14 | Each active promotion has the required fields | happy | functional | Outputs: each element has id, name, type, status, startsAt, endsAt, priority, requiresCoupon |
| TC-PROMO-1-15 | GET /active returns 200 and an empty array when nothing is active | happy | functional | Outputs: when no promotion is active it returns 200 with [] |
| TC-PROMO-1-16 | A promotion with StartsAt equal to now is active | sad | functional | Outputs: StartsAt <= now |
| TC-PROMO-1-17 | A promotion with EndsAt equal to now is not active | sad | functional | Outputs: now < EndsAt |
| TC-PROMO-1-18 | GET /active ignores a malformed bearer token | sad | functional | Outputs: ignores any bearer token sent with it; AC: malformed bearer token still returns 200 |
| TC-PROMO-1-19 | GET /active returns the same result with a valid token | happy | functional | Outputs: ignores any bearer token sent with it |
| TC-PROMO-1-20 | GET /api/promotions with a promotions-scope token returns every promotion | happy | functional | Outputs: GET /api/promotions returns 200 with every promotion, active or not |
| TC-PROMO-1-21 | Signing in to the WebApp yields a token with the promotions scope that is accepted | happy | e2e | AC: user signs in to the WebApp; Outputs: WebApp requests the promotions scope at sign-in |
| TC-PROMO-1-22 | GET /api/promotions without a token returns 401 | sad | functional | Outputs: without a token returns 401; AC: called without a token |
| TC-PROMO-1-23 | GET /api/promotions with a malformed token returns 401 | sad | functional | Outputs: malformed token returns 401 |
| TC-PROMO-1-24 | GET /api/promotions with an expired token returns 401 | sad | functional | Outputs: expired token returns 401 |
| TC-PROMO-1-25 | Identity discovery document lists the promotions scope | happy | functional | Outputs: Identity has an API resource and an API scope named promotions |
| TC-PROMO-1-26 | Other clients cannot request the promotions scope | sad | functional | Outputs: promotions is in the webapp client's allowed scopes only |

## Out of scope

- Rejecting a token issued for another audience (BUG-6; `AddDefaultAuthentication` does not validate the audience yet).
- Concurrent seeding by two instances, recovery after a database outage, and the exact `WWW-Authenticate` header or body of a `401`.
- Measuring startup order; `WaitFor` is checked on the resource model only.
- Promotions.API in the `mobile-bff` YARP routes (decided: not added yet).

## Open questions

- `/health` and `/alive` are mapped only in the `Development` environment (`MapDefaultEndpoints`), while the story says they return 200; TC-PROMO-1-10 assumes Development. The test stack runs Production and polls `/api/promotions/active` instead.
- "`promotions-api` and `promotionsdb` show as healthy in the Aspire dashboard" needs the running dashboard; only the health check wiring is covered (TC-PROMO-1-02).
- The story does not say what `GET /api/promotions` returns for a valid token that lacks the `promotions` scope; no case written.
- The story does not define behavior for a missing or unsupported `api-version`; no case written.
- Statuses other than `Draft` and `Published` are not defined by the story; only `Draft` is tested as non-active.
- The seeded priorities (10, 8, 6, 5) come from the implementation notes, not the story's requirements; TC-PROMO-1-12 relies on them.
