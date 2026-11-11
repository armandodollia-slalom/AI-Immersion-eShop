---
id: TC-BUG-21-03
title: v1 PUT with a negative id returns 400 with the id-required message
type: sad
sad-path: boundary
layer: functional
covers: ["Technical Notes: Id <= 0 check", "Decisions: negative ids get the same 400"]
priority: P2
---

# TC-BUG-21-03: v1 PUT with a negative id returns 400 with the id-required message

## Why

- The suggested fix and the Implementation Notes decide that negative ids are rejected like 0 because database ids start at 1; protects the lower side of the boundary.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (14 items, ids 1-14); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"id": -1, "name": "Edge 15 New Lantern", "price": 42.5, "catalogTypeId": 3, "catalogBrandId": 2}`.

## Expected result

- Step 1 returns 400 with `detail` "Item id must be provided in the request body.".
