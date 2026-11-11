---
id: TC-BUG-13-05
title: v2 PUT with a negative price returns 400 and leaves the item unchanged
type: sad
sad-path: validation
layer: functional
covers: ["Technical Notes: UpdateItem has no validation","Implementation Notes: invalid body never changes the DB"]
priority: P1
---

# TC-BUG-13-05: v2 PUT with a negative price returns 400 and leaves the item unchanged

## Why

- Price is the other field rule on update; the integration event is not observable through the API, so only the persisted price is asserted.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `GET /api/catalog/items/1?api-version=2.0`, note `name` and `price`.
2. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` with the admin token and body `{"id":1,"name":"<name from step 1>","description":"Edge","price":-5,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.
3. `GET /api/catalog/items/1?api-version=2.0`.

## Expected result

- Status is 400.
- The body is a validation problem (`application/problem+json`) with an `errors` object.
- The GET in step 3 returns the same `price` as in step 1.
