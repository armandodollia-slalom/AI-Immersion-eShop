---
id: TC-BUG-19-09
title: Create with existing brand and type, including unused ones, still returns 201
type: happy
layer: functional
covers: ["Acceptance: rest of the file still passes", "Fix must not reject valid ids"]
priority: P1
---

# TC-BUG-19-09: Create with existing brand and type, including unused ones, still returns 201

## Why

- Guards against an over-eager check. Brand 4 and type 4 have no items, showing that existence in the lookup tables, not use by items, is what counts.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (brand 4 and type 4 exist, no items use them).
- Admin bearer token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"name":"Edge 15 New Lantern","description":"Edge","price":42.5,"pictureFileName":"7.webp","catalogTypeId":4,"catalogBrandId":4,"availableStock":12,"restockThreshold":2,"maxStockThreshold":50}`.
2. `GET` the item at the `Location` header URL.

## Expected result

- Step 1 returns 201 with a `Location` header `/api/catalog/items/<id>`.
- Step 2 returns `catalogTypeId` 4 and `catalogBrandId` 4.
