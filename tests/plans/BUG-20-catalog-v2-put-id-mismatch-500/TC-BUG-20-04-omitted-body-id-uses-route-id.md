---
id: TC-BUG-20-04
title: v2 PUT without a body id uses the route id
type: happy
layer: functional
covers: ["Decisions: a body id of 0 or omitted is set to the route id"]
priority: P2
---

# TC-BUG-20-04: v2 PUT without a body id uses the route id

## Why

- The fix treats body id 0 (the default for an omitted id) as "not set", so the mismatch check must not reject it. If the check were `!=` only, every id-less v2 PUT would regress to 400. Distinct from TC-BUG-20-03 because it exercises the id-defaulting branch.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (item 7 "Edge 07 Dome Tent" exists); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/7?api-version=2.0` as admin with body `{"name": "Edge 15 New Lantern", "description": "Created by the admin API test.", "price": 42.5, "pictureFileName": "7.webp", "catalogTypeId": 3, "catalogBrandId": 2, "availableStock": 12, "restockThreshold": 2, "maxStockThreshold": 50}` (no `id` field).
2. `GET http://localhost:18082/api/catalog/items/7?api-version=1.0`.

## Expected result

- Step 1 returns 201.
- Step 2 returns 200 with `id` 7, `name` "Edge 15 New Lantern" and `price` 42.5.
