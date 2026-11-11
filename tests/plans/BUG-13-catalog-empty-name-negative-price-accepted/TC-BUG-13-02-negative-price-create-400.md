---
id: TC-BUG-13-02
title: Create with a negative price returns 400
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest for negative price","Steps to Reproduce 2"]
priority: P1
---

# TC-BUG-13-02: Create with a negative price returns 400

## Why

- Reported bug: price -5 is stored with 201. Separate case from the name because it is a different field rule.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (`testing/teststack load catalog-edge`).
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with the admin token and body `{"name":"Edge Negative Price","description":"Edge","price":-5,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}`.

## Expected result

- Status is 400 (not 201).
- The body is a validation problem (`application/problem+json`) with an `errors` object.

