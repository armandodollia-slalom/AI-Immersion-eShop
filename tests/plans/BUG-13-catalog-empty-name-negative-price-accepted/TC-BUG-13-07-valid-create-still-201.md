---
id: TC-BUG-13-07
title: Valid create still returns 201
type: happy
layer: functional
covers: ["Acceptance: rest of catalog-admin.spec.ts still passes"]
priority: P1
---

# TC-BUG-13-07: Valid create still returns 201

## Why

- Guards against over-strict validation breaking the normal create path.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with the admin token and body `{"name":"Edge Valid Boot","description":"Edge","price":25,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.

## Expected result

- Status is 201 with a `Location` header starting `/api/catalog/items/`.
- `GET` on that location returns `name` `Edge Valid Boot` and `price` 25.
