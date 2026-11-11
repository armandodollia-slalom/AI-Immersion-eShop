---
id: TC-PROMO-1-10
title: /health and /alive return 200 when the database is reachable
type: happy
layer: functional
covers: ["Outputs: /health and /alive return 200"]
priority: P1
---

# TC-PROMO-1-10: /health and /alive return 200 when the database is reachable

## Why

- Aspire's health check and readiness depend on these endpoints; checked at the functional layer because it needs the real service and database.

## Preconditions

- Promotions.API running in the `Development` environment (`MapDefaultEndpoints` maps the endpoints only there) with a reachable `promotionsdb`.

## Steps

1. `GET /health` anonymously.
2. `GET /alive` anonymously.

## Expected result

- Both return status `200`.
