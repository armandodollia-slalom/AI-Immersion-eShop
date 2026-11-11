---
id: TC-BUG-20-03
title: v2 PUT with a body id equal to the route id still returns 201 and updates the item
type: happy
layer: functional
covers: ["Fix must not break a valid update", "Boundary: ids match"]
priority: P1
---

# TC-BUG-20-03: v2 PUT with a body id equal to the route id still returns 201 and updates the item

## Why

- Guards against an over-eager check that rejects valid updates. It is the matching-id counterpart of TC-BUG-20-01, so a regression in either direction is caught at the same layer.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (item 4 "Edge 04 Day Pack" exists); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/4?api-version=2.0` as admin with body `{"id": 4, "name": "Edge 15 New Lantern", "description": "Created by the admin API test.", "price": 42.5, "pictureFileName": "7.webp", "catalogTypeId": 3, "catalogBrandId": 2, "availableStock": 12, "restockThreshold": 2, "maxStockThreshold": 50}`.
2. `GET http://localhost:18082/api/catalog/items/4?api-version=1.0`.

## Expected result

- Step 1 returns 201.
- Step 2 returns 200 with `id` 4, `name` "Edge 15 New Lantern" and `price` 42.5.
