---
id: TC-BUG-21-05
title: v1 PUT with a valid body id still updates the item
type: happy
layer: functional
covers: ["Fix must not break a valid update", "Related: v1 PUT takes the id from the body"]
priority: P1
---

# TC-BUG-21-05: v1 PUT with a valid body id still updates the item

## Why

- Regression guard at the lower valid boundary: id 1 is the smallest database-generated id and must pass the new `Id <= 0` check.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (14 items, ids 1-14); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"id": 1, "name": "Edge 01 Penny Boot v2", "price": 0.02, "catalogTypeId": 1, "catalogBrandId": 1}`.
2. `GET http://localhost:18082/api/catalog/items/1?api-version=1.0`.

## Expected result

- Step 1 returns 201.
- Step 2 returns 200 with `id` 1, `name` "Edge 01 Penny Boot v2" and `price` 0.02.
