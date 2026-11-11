---
id: TC-BUG-21-06
title: v1 PUT with an unknown positive id still returns 404
type: sad
sad-path: not-found
layer: functional
covers: ["Actual: 404 \"Item with id N not found.\" remains for real ids"]
priority: P2
---

# TC-BUG-21-06: v1 PUT with an unknown positive id still returns 404

## Why

- The 404 must survive the fix for ids that are valid but absent, so only the missing-id case changes status.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (14 items, ids 1-14); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"id": 99999, "name": "Edge 15 New Lantern", "price": 42.5, "catalogTypeId": 3, "catalogBrandId": 2}`.

## Expected result

- Step 1 returns 404 with `detail` "Item with id 99999 not found.".
