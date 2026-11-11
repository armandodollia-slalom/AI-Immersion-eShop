---
id: TC-BUG-21-01
title: v1 PUT with no id in the body returns 400 with the id-required message
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest", "Steps to Reproduce", "Acceptance Criteria: result matches Expected"]
priority: P1
---

# TC-BUG-21-01: v1 PUT with no id in the body returns 400 with the id-required message

## Why

- This is the reported bug: the dead `Id == null` check let a missing id bind to 0 and surface as 404. Functional layer because the binding of an absent `id` to 0 happens in the real HTTP pipeline.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (14 items, ids 1-14); admin token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"name": "Edge 15 New Lantern", "description": "Created by the admin API test.", "price": 42.5, "pictureFileName": "7.webp", "catalogTypeId": 3, "catalogBrandId": 2, "availableStock": 12, "restockThreshold": 2, "maxStockThreshold": 50}` (no `id` property).

## Expected result

- Step 1 returns 400 with content type `application/problem+json` and `detail` "Item id must be provided in the request body.".
- The response does not contain "Item with id 0 not found.".
