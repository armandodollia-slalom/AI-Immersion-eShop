---
id: TC-BUG-19-01
title: Create with an unknown brand id returns 400 naming the id
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest naming the unknown id", "Steps to Reproduce 1", "Implementation Notes: message text"]
priority: P1
---

# TC-BUG-19-01: Create with an unknown brand id returns 400 naming the id

## Why

- This is the reported bug (step 1): a nonexistent brand reaches Postgres and returns 500. Functional layer because the foreign key violation only appears against the real database.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (brands 1-4, types 1-4, items 1-14).
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"name":"Edge 15 New Lantern","description":"Edge","price":42.5,"pictureFileName":"7.webp","catalogTypeId":3,"catalogBrandId":999,"availableStock":12,"restockThreshold":2,"maxStockThreshold":50}`.

## Expected result

- Status is 400 (not 500), `application/problem+json` validation problem.
- `errors.CatalogBrandId` (key matched case-insensitively) contains "Catalog brand with id 999 does not exist.".
- `errors` has no catalog type entry.
