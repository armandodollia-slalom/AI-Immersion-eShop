---
id: TC-BUG-18-01
title: Create with an existing id returns 409
type: sad
sad-path: conflict
layer: functional
covers: ["Expected: 409 Conflict", "Steps to Reproduce: POST with id 1"]
priority: P1
---

# TC-BUG-18-01: Create with an existing id returns 409

## Why

- The bug is a 500 from a Postgres primary key violation when the body carries an id that exists. The risk is a server error for a client conflict; the real database is needed to hit the key violation, so this is functional.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (item id 1 "Edge 01 Penny Boot" exists); admin token (user `admin`).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"id": 1, "name": "Edge 15 New Lantern", "description": "Created by the admin API test.", "price": 42.5, "pictureFileName": "7.webp", "catalogTypeId": 3, "catalogBrandId": 2, "availableStock": 12, "restockThreshold": 2, "maxStockThreshold": 50}`.

## Expected result

- Status is 409.
- Status is not 500.
