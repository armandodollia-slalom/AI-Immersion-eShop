---
id: TC-BUG-19-11
title: v1 PUT with an unknown type id returns 400 naming the id
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 on update", "Implementation Notes: v1 PUT /items", "Message text for type"]
priority: P2
---

# TC-BUG-19-11: v1 PUT with an unknown type id returns 400 naming the id

## Why

- TC-BUG-19-08 covers only the brand on v1; the type check is a separate field and the story names both ids. Functional layer: needs real Postgres to reproduce the former foreign key 500.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (item 1 exists).
- Admin bearer token.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` as admin with body `{"id":1,"name":"Edge 01 Penny Boot","description":"Edge","price":42.5,"pictureFileName":"1.webp","catalogTypeId":999,"catalogBrandId":1,"availableStock":10,"restockThreshold":5,"maxStockThreshold":100}`.

## Expected result

- Status is 400 (not 500), validation problem with `errors.CatalogTypeId` containing "Catalog type with id 999 does not exist.".
