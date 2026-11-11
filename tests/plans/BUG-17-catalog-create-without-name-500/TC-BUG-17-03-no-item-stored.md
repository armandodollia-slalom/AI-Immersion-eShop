---
id: TC-BUG-17-03
title: Rejected create without name stores no item
type: sad
sad-path: validation
layer: functional
covers: ["Actual: Postgres NOT NULL violation on Name", "Validate required fields before saving"]
priority: P2
---

# TC-BUG-17-03: Rejected create without name stores no item

## Why

- The fix validates before saving; the risk is a rejected request still persisting a partial row. Functional layer needs the real database to observe persisted state.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded; admin token.
- Record the `count` from `GET /api/catalog/items?api-version=2.0&pageSize=1&pageIndex=0` (call it N).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with the body from TC-BUG-17-01 (no `name`).
2. Repeat the count request from Preconditions.

## Expected result

- Step 1 returns 400.
- Step 2 `count` equals N.
