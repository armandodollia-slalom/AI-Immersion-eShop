---
id: TC-BUG-19-10
title: v2 PUT with existing brand and type still succeeds
type: happy
layer: functional
covers: ["Acceptance: rest of the file still passes", "Fix must not reject valid ids (update)"]
priority: P2
---

# TC-BUG-19-10: v2 PUT with existing brand and type still succeeds

## Why

- Ensures the update reference check does not block legitimate edits.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (item 2 exists).
- Admin bearer token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/2?api-version=2.0` as admin with body `{"id":2,"name":"Edge 02 Trail Boot","description":"Edge","price":42.5,"pictureFileName":"2.webp","catalogTypeId":3,"catalogBrandId":2,"availableStock":10,"restockThreshold":5,"maxStockThreshold":100}`.
2. `GET http://localhost:18082/api/catalog/items/2?api-version=2.0`.

## Expected result

- Step 1 returns a 2xx status.
- Step 2 returns `catalogTypeId` 3, `catalogBrandId` 2 and price 42.5.
