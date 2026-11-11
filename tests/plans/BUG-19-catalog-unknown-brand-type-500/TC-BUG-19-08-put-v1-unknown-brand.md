---
id: TC-BUG-19-08
title: v1 PUT with an unknown brand id returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 on update", "Implementation Notes: v1 PUT /items"]
priority: P2
---

# TC-BUG-19-08: v1 PUT with an unknown brand id returns 400

## Why

- The v1 PUT (`UpdateItemV1`, id in the body) is a separate route sharing the update logic; this guards that the check applies there too.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- Admin bearer token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"id":1,"name":"Edge 01 Penny Boot","description":"Edge","price":42.5,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":999,"availableStock":10,"restockThreshold":5,"maxStockThreshold":100}`.

## Expected result

- Status is 400 (not 500), validation problem with `errors.CatalogBrandId` containing "Catalog brand with id 999 does not exist.".
