---
id: TC-BUG-11-14
title: GET items by type and brand with negative paging is 400
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: applied to GetItemsByTypeAndBrand"]
priority: P2
---

# TC-BUG-11-14: GET items by type and brand with negative paging is 400

## Why

- Separate route and handler (`GetItemsByBrandAndTypeId`) that also uses `PaginationRequest`.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items/type/1/brand/1?api-version=1.0&pageSize=-1` anonymously.
2. `GET http://localhost:18082/api/catalog/items/type/1/brand/1?api-version=1.0&pageIndex=-1` anonymously.

## Expected result

- Both responses are `400` with `application/problem+json`.
- Each body has `status` 400 and a non-empty `errors` object; the first concerns `pageSize`, the second `pageIndex` (no message wording asserted); neither response is `500`.
