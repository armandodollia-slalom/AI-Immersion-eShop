---
id: TC-BUG-20-01
title: v2 PUT with body id 2 on route id 1 returns 400 with the mismatch message
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest Route id and body id must match", "Steps to Reproduce: PUT items/1 with body id 2"]
priority: P1
---

# TC-BUG-20-01: v2 PUT with body id 2 on route id 1 returns 400 with the mismatch message

## Why

- The bug is a 500 when EF tries to change the key of the tracked entity loaded by the route id. The risk is a server error for a client input mistake; the real database and EF tracking are needed to hit it, so this is functional. This is the story's exact reproduction.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (items 1 "Edge 01 Penny Boot" and 2 "Edge 02 Trail Boot" exist); admin token (user `admin`, scope `catalog`).

## Steps

1. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` as admin with body `{"id": 2, "name": "Edge 15 New Lantern", "description": "Created by the admin API test.", "price": 42.5, "pictureFileName": "7.webp", "catalogTypeId": 3, "catalogBrandId": 2, "availableStock": 12, "restockThreshold": 2, "maxStockThreshold": 50}`.

## Expected result

- Status is 400.
- Status is not 500.
- The response body has `status` 400 and `detail` "Route id and body id must match".
