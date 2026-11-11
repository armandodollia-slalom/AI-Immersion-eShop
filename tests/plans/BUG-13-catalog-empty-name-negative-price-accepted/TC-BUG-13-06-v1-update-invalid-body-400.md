---
id: TC-BUG-13-06
title: v1 PUT /items with an empty name returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: v1 PUT /items returns ValidationProblem"]
priority: P1
---

# TC-BUG-13-06: v1 PUT /items with an empty name returns 400

## Why

- The v1 update route is a separate code path from v2 and could be left unvalidated.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `GET /api/catalog/items/1?api-version=2.0`, note `name`.
2. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` with the admin token and body `{"id":1,"name":"","description":"Edge","price":10,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.
3. `GET /api/catalog/items/1?api-version=2.0`.

## Expected result

- Status is 400.
- The body is a validation problem (`application/problem+json`) with an `errors` object.
- The GET in step 3 returns the same `name` as in step 1.
