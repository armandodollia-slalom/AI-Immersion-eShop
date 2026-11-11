---
id: TC-BUG-17-01
title: Create without name returns 400 validation problem
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest with a validation problem", "Acceptance: steps repeated match Expected"]
priority: P1
---

# TC-BUG-17-01: Create without name returns 400 validation problem

## Why

- This is the reported bug: a missing name reaches Postgres and returns 500. Functional layer because the API plus the real database NOT NULL constraint is where the failure appears.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- Admin bearer token (catalog write scope).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with the admin token and JSON body `{"description":"No name","price":10,"pictureFileName":"1.webp","catalogTypeId":1,"catalogBrandId":1,"availableStock":5,"restockThreshold":1,"maxStockThreshold":10}` (no `name` property).

## Expected result

- Status is 400 (not 500).
- The body is a validation problem (`application/problem+json`) with an `errors` object.
