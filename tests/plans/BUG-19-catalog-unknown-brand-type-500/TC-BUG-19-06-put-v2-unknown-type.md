---
id: TC-BUG-19-06
title: v2 PUT with an unknown type id returns 400 and leaves the item unchanged
type: sad
sad-path: validation
layer: functional
covers: ["Steps to Reproduce 2", "Expected: 400 BadRequest naming the unknown id"]
priority: P1
---

# TC-BUG-19-06: v2 PUT with an unknown type id returns 400 and leaves the item unchanged

## Why

- Second reported repro (update path). Update uses a different handler from create, so it needs its own case; it also checks nothing was saved.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (item 1 "Edge 01 Penny Boot", price 0.01, type 1, brand 1).
- Admin bearer token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` as admin with body `{"id":1,"name":"Edge 01 Penny Boot","description":"Edge","price":42.5,"pictureFileName":"1.webp","catalogTypeId":999,"catalogBrandId":1,"availableStock":10,"restockThreshold":5,"maxStockThreshold":100}`.
2. `GET http://localhost:18082/api/catalog/items/1?api-version=2.0`.

## Expected result

- Step 1 returns 400 (not 500), validation problem with `errors.CatalogTypeId` containing "Catalog type with id 999 does not exist.".
- Step 2 returns `catalogTypeId` 1, `catalogBrandId` 1, name "Edge 01 Penny Boot" and price 0.01.
