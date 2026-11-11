---
id: TC-BUG-13-11
title: v1 PUT /items with a negative price returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: v1 PUT /items returns ValidationProblem"]
priority: P1
---

# TC-BUG-13-11: v1 PUT /items with a negative price returns 400

## Why

- The v1 route is a separate code path; its price rule needs its own case.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `GET /api/catalog/items/1?api-version=2.0`, note `price`.
2. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` with the admin token and body `{"id":1,"name":"Edge 01 Penny Boot","description":"Edge","price":-5,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.
3. `GET /api/catalog/items/1?api-version=2.0`.

## Expected result

- Status is 400.
- The body is a validation problem (`application/problem+json`) with an `errors` object.
- The GET in step 3 returns the same `price` as in step 1.
