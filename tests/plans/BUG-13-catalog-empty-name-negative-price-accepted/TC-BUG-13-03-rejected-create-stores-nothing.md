---
id: TC-BUG-13-03
title: Rejected create stores no item
type: sad
sad-path: validation
layer: functional
covers: ["Actual: items show up in the store"]
priority: P1
---

# TC-BUG-13-03: Rejected create stores no item

## Why

- The bug's visible harm is bad rows in the store; this proves rejection means nothing is persisted.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageIndex=0&pageSize=100`, note `count`.
2. `POST` the empty-name body from TC-BUG-13-01 to `/api/catalog/items?api-version=2.0` with the admin token.
3. `POST` the price -5 body from TC-BUG-13-02 the same way.
4. Repeat step 1.

## Expected result

- Steps 2 and 3 return 400.
- `count` in step 4 equals `count` from step 1.
- No returned item has an empty `name` or a negative `price`.
