---
id: TC-BUG-21-02
title: v1 PUT with an explicit id of 0 returns 400 with the id-required message
type: sad
sad-path: boundary
layer: functional
covers: ["Expected: 400 BadRequest", "Technical Notes: Id <= 0 check", "Decisions: 0 is indistinguishable from a missing id"]
priority: P1
---

# TC-BUG-21-02: v1 PUT with an explicit id of 0 returns 400 with the id-required message

## Why

- Boundary just outside the valid range: an explicit 0 binds identically to a missing id and must be rejected the same way.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (14 items, ids 1-14); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"id": 0, "name": "Edge 15 New Lantern", "price": 42.5, "catalogTypeId": 3, "catalogBrandId": 2}`.

## Expected result

- Step 1 returns 400 with `detail` "Item id must be provided in the request body.".
