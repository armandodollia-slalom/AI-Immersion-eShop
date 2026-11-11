---
id: TC-BUG-13-04
title: v2 PUT with an empty name returns 400 and leaves the item unchanged
type: sad
sad-path: validation
layer: functional
covers: ["Technical Notes: UpdateItem has no validation","Implementation Notes: v2 PUT /items/{id}"]
priority: P1
---

# TC-BUG-13-04: v2 PUT with an empty name returns 400 and leaves the item unchanged

## Why

- UpdateItem is named in the story's technical notes as unvalidated; it must reject and not modify the row or publish a price event.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `GET /api/catalog/items/1?api-version=2.0`, note `name` and `price`.
2. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` with the admin token and body `{"id":1,"name":"","description":"Edge","price":10,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.
3. `GET /api/catalog/items/1?api-version=2.0`.

## Expected result

- Status is 400.
- The body is a validation problem (`application/problem+json`) with an `errors` object.
- The GET in step 3 returns the same `name` and `price` as the GET in step 1.
