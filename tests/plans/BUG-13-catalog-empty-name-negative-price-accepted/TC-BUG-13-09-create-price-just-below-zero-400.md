---
id: TC-BUG-13-09
title: Create with price -0.01 returns 400
type: sad
sad-path: boundary
layer: functional
covers: ["Implementation Notes: Price >= 0"]
priority: P1
---

# TC-BUG-13-09: Create with price -0.01 returns 400

## Why

- Just-outside value of the price boundary; catches a check like `Price > -1`.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with the admin token and body `{"name":"Edge Tiny Negative","description":"Edge","price":-0.01,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.

## Expected result

- Status is 400 with a validation problem (`application/problem+json`) and an `errors` object.
- `GET /api/catalog/items?api-version=2.0` does not contain an item named `Edge Tiny Negative`.
