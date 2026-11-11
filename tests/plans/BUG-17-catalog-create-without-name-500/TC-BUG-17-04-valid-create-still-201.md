---
id: TC-BUG-17-04
title: Create with a name still returns 201
type: happy
layer: functional
covers: ["Validation must not reject valid creates", "Rest of catalog-admin.spec.ts still passes"]
priority: P1
---

# TC-BUG-17-04: Create with a name still returns 201

## Why

- The new validator sits in front of the save; the regression risk is rejecting valid bodies. Functional layer, same endpoint as the bug.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded; admin token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"name":"BUG-17 Valid Item","description":"Has name","price":10,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.
2. `GET` the URL in the `Location` header of the response.

## Expected result

- Step 1 returns 201 with a `Location` header.
- Step 2 returns 200 with `name` equal to `BUG-17 Valid Item`.
