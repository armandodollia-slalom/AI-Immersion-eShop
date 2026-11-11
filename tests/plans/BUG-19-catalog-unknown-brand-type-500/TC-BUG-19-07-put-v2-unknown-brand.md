---
id: TC-BUG-19-07
title: v2 PUT with an unknown brand id returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest naming the unknown id (update)"]
priority: P1
---

# TC-BUG-19-07: v2 PUT with an unknown brand id returns 400

## Why

- Brand is validated separately from type; the reported update repro only covers type, so a brand-only gap would go unnoticed.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- Admin bearer token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` as admin with body `{"id":1,"name":"Edge 01 Penny Boot","description":"Edge","price":42.5,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":999,"availableStock":10,"restockThreshold":5,"maxStockThreshold":100}`.

## Expected result

- Status is 400 (not 500), validation problem with `errors.CatalogBrandId` containing "Catalog brand with id 999 does not exist.".
