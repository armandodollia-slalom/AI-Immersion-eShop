---
id: TC-BUG-19-04
title: Create with empty name and unknown brand reports both fields
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: collected with name and price errors"]
priority: P2
---

# TC-BUG-19-04: Create with empty name and unknown brand reports both fields

## Why

- Reference errors are merged with the existing name and price validation; a regression could drop one set of errors.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- Admin bearer token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"name":"","description":"Edge","price":42.5,"pictureFileName":"7.webp","catalogTypeId":3,"catalogBrandId":999,"availableStock":12,"restockThreshold":2,"maxStockThreshold":50}`.

## Expected result

- Status is 400.
- `errors` contains a `Name` entry and a `CatalogBrandId` entry containing "Catalog brand with id 999 does not exist.".
