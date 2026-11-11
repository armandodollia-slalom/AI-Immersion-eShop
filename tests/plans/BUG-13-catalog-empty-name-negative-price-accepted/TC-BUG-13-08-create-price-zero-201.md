---
id: TC-BUG-13-08
title: Create with price 0 returns 201
type: happy
layer: functional
covers: ["Implementation Notes: Price >= 0, zero allowed"]
priority: P1
---

# TC-BUG-13-08: Create with price 0 returns 201

## Why

- Implementation notes fix the boundary at Price >= 0; zero is the just-inside value.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with the admin token and body `{"name":"Edge Zero Price","description":"Edge","price":0,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.

## Expected result

- Status is 201 with a `Location` header for the new item.
- `GET` of that location returns `price` 0 and `name` `Edge Zero Price`.
