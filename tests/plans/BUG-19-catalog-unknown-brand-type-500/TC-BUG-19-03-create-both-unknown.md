---
id: TC-BUG-19-03
title: Create with unknown brand and type reports both errors in one 400
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: errors collected together"]
priority: P2
---

# TC-BUG-19-03: Create with unknown brand and type reports both errors in one 400

## Why

- The implementation collects errors so one response lists every invalid field; a short-circuit after the first failure would hide the second.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- Admin bearer token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"name":"Edge 15 New Lantern","description":"Edge","price":42.5,"pictureFileName":"7.webp","catalogTypeId":999,"catalogBrandId":998,"availableStock":12,"restockThreshold":2,"maxStockThreshold":50}`.

## Expected result

- Status is 400.
- `errors.CatalogBrandId` contains "Catalog brand with id 998 does not exist.".
- `errors.CatalogTypeId` contains "Catalog type with id 999 does not exist.".
