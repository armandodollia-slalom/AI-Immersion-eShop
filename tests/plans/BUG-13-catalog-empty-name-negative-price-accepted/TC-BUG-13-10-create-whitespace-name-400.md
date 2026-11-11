---
id: TC-BUG-13-10
title: Create with a whitespace-only name returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: Empty/whitespace name rejected"]
priority: P1
---

# TC-BUG-13-10: Create with a whitespace-only name returns 400

## Why

- Code map states whitespace names are rejected; distinct from the empty string.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with the admin token and body `{"name":"   ","description":"Edge","price":10,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.

## Expected result

- Status is 400 with a validation problem (`application/problem+json`) and an `errors` object.
- No item with a blank name is returned by `GET /api/catalog/items?api-version=2.0`.
