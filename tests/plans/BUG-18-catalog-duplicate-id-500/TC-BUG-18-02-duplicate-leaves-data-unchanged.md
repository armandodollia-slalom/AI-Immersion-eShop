---
id: TC-BUG-18-02
title: Rejected duplicate create leaves the existing item and the count unchanged
type: sad
sad-path: conflict
layer: functional
covers: ["Actual: primary key violation", "Expected: 409 Conflict (nothing created or overwritten)"]
priority: P1
---

# TC-BUG-18-02: Rejected duplicate create leaves the existing item and the count unchanged

## Why

- A 409 is only correct if the request had no side effects. The risk is a fix that overwrites item 1 or adds a row before failing. Persisted state needs the real database, so functional.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded; admin token.
- Record `count` from `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageSize=1&pageIndex=0` (call it N; expected 14).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with the body from TC-BUG-18-01 (`"id": 1`, name "Edge 15 New Lantern").
2. `GET http://localhost:18082/api/catalog/items/1?api-version=1.0`.
3. Repeat the count request from Preconditions.

## Expected result

- Step 1 returns 409.
- Step 2 returns 200 with `name` equal to "Edge 01 Penny Boot" (not "Edge 15 New Lantern").
- Step 3 `count` equals N.
