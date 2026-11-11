---
id: TC-BUG-4-05
title: Rejected anonymous writes leave the catalog unchanged
type: sad
sad-path: auth
layer: functional
covers: ["Actual: anyone can change products and prices"]
priority: P1
---

# TC-BUG-4-05: Rejected anonymous writes leave the catalog unchanged

## Why

- Guards against auth that runs after the handler (status 401 but data still changed, price event still published). Checks persisted state across all three write verbs together.

## Preconditions

- Test stack up, `catalog-edge` loaded. Snapshot anonymous `GET /api/catalog/items?api-version=2.0&pageIndex=0&pageSize=100` (full body) and `GET /api/catalog/items/1?api-version=2.0`.

## Steps

1. Anonymous `POST /api/catalog/items?api-version=2.0` with a valid item.
2. Anonymous `PUT /api/catalog/items/1?api-version=2.0` changing price to 999.99.
3. Anonymous `DELETE /api/catalog/items/1?api-version=2.0`.
4. Repeat the snapshot GETs.

## Expected result

- Steps 1-3 each return 401.
- Both snapshot bodies are identical to the preconditions (same count, same item 1 price and name).
