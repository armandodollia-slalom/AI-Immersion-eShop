---
id: TC-BUG-21-04
title: Rejected v1 PUT without an id leaves the catalog unchanged
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400, request rejected", "Actual: id 0 lookup"]
priority: P2
---

# TC-BUG-21-04: Rejected v1 PUT without an id leaves the catalog unchanged

## Why

- The 400 must come before any lookup or write, so a rejected request cannot create or modify an item. Separate from TC-BUG-21-01 because it asserts persisted state rather than the response.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (14 items, ids 1-14); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"name": "Edge 15 New Lantern", "description": "Created by the admin API test.", "price": 42.5, "pictureFileName": "7.webp", "catalogTypeId": 3, "catalogBrandId": 2, "availableStock": 12, "restockThreshold": 2, "maxStockThreshold": 50}` (no `id`).
2. `GET http://localhost:18082/api/catalog/items?api-version=1.0`.
3. `GET http://localhost:18082/api/catalog/items/1?api-version=1.0`.

## Expected result

- Step 1 returns 400.
- Step 2 returns `count` 14.
- Step 3 returns 200 with `id` 1, `name` "Edge 01 Penny Boot" and `price` 0.01.
