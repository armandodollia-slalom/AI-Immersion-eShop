---
id: TC-BUG-13-01
title: Create with an empty name returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest for empty name","Steps to Reproduce 1"]
priority: P1
---

# TC-BUG-13-01: Create with an empty name returns 400

## Why

- Reported bug: an empty name is stored with 201. Functional layer because the API and real database are involved.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with the admin token and body `{"name":"","description":"Edge","price":10,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.

## Expected result

- Status is 400 (not 201).
- The body is a validation problem (`application/problem+json`) with an `errors` object.

