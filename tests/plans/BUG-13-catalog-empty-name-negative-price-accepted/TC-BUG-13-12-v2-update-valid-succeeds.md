---
id: TC-BUG-13-12
title: Valid v2 PUT still succeeds and persists
type: happy
layer: functional
covers: ["Implementation Notes: validation first in UpdateItem"]
priority: P1
---

# TC-BUG-13-12: Valid v2 PUT still succeeds and persists

## Why

- Validation now runs before the item lookup in update; a valid body must still reach the lookup and persist.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `GET /api/catalog/items/1?api-version=2.0`, note `name`.
2. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` with the admin token and body `{"id":1,"name":"<name from step 1>","description":"Edge","price":12.5,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.
3. `GET /api/catalog/items/1?api-version=2.0`.

## Expected result

- Status is a 2xx success (not 400).
- The GET in step 3 returns `price` 12.5.
