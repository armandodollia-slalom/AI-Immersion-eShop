---
id: TC-BUG-20-02
title: Rejected mismatch PUT leaves items 1 and 2 unchanged
type: sad
sad-path: validation
layer: functional
covers: ["Actual: EF changes the key of a tracked entity", "Expected: 400, request rejected"]
priority: P1
---

# TC-BUG-20-02: Rejected mismatch PUT leaves items 1 and 2 unchanged

## Why

- The id check must run before the item is loaded and SetValues copies fields, otherwise a rejected request could still overwrite item 1 or collide with item 2. Separate from TC-BUG-20-01 because it asserts persisted state, not the response.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded; admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` as admin with body `{"id": 2, "name": "Edge 15 New Lantern", "description": "Created by the admin API test.", "price": 42.5, "pictureFileName": "7.webp", "catalogTypeId": 3, "catalogBrandId": 2, "availableStock": 12, "restockThreshold": 2, "maxStockThreshold": 50}`.
2. `GET http://localhost:18082/api/catalog/items/1?api-version=1.0`.
3. `GET http://localhost:18082/api/catalog/items/2?api-version=1.0`.
4. `GET http://localhost:18082/api/catalog/items?api-version=1.0`.

## Expected result

- Step 1 returns 400.
- Step 2 returns 200 with `id` 1, `name` "Edge 01 Penny Boot" and `price` 0.01.
- Step 3 returns 200 with `id` 2, `name` "Edge 02 Trail Boot" and `price` 59.5.
- Step 4 returns `count` 14.
