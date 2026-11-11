---
id: TC-BUG-4-11
title: Catalog reads stay anonymous
type: happy
layer: functional
covers: ["Suggested fix: Reads stay anonymous"]
priority: P1
---

# TC-BUG-4-11: Catalog reads stay anonymous

## Why

- The WebApp and Basket/Ordering read the catalog without a token; a global requirement would break the storefront.

## Preconditions

- Test stack up, `catalog-edge` loaded.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageIndex=0&pageSize=10` with no `Authorization` header.
2. `GET http://localhost:18082/api/catalog/items/1?api-version=2.0` with no `Authorization` header.

## Expected result

- Both return 200; step 1 body has a non-empty `data` array, step 2 has `id` 1.
