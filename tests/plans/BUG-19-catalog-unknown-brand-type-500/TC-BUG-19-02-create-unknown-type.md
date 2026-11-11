---
id: TC-BUG-19-02
title: Create with an unknown type id returns 400 naming the id
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest naming the unknown id", "Implementation Notes: message text"]
priority: P1
---

# TC-BUG-19-02: Create with an unknown type id returns 400 naming the id

## Why

- Brand and type are checked independently; a fix covering only one would still return 500 for the other (the spec test posts both). Functional layer for the same reason as TC-BUG-19-01.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- Admin bearer token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"name":"Edge 15 New Lantern","description":"Edge","price":42.5,"pictureFileName":"7.webp","catalogTypeId":999,"catalogBrandId":2,"availableStock":12,"restockThreshold":2,"maxStockThreshold":50}`.

## Expected result

- Status is 400 (not 500), validation problem.
- `errors.CatalogTypeId` (case-insensitive) contains "Catalog type with id 999 does not exist.".
- `errors` has no catalog brand entry.
