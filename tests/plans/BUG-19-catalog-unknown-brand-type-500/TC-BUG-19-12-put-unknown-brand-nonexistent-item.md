---
id: TC-BUG-19-12
title: v2 PUT to a nonexistent item with an unknown brand returns 400, not 404
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: reference check runs before any item lookup or save"]
priority: P2
---

# TC-BUG-19-12: v2 PUT to a nonexistent item with an unknown brand returns 400, not 404

## Why

- The Implementation Notes state the reference check runs before the item lookup. Distinguishes validation-first ordering from a lookup-first implementation.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- No catalog item with id 999999.
- Admin bearer token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/999999?api-version=2.0` as admin with body `{"id":999999,"name":"Ghost","description":"Edge","price":10,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":999,"availableStock":10,"restockThreshold":5,"maxStockThreshold":100}`.

## Expected result

- Status is 400 (not 404, not 500), validation problem with `errors.CatalogBrandId` containing "Catalog brand with id 999 does not exist.".
