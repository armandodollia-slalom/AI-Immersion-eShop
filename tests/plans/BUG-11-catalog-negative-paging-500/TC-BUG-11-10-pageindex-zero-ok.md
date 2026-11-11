---
id: TC-BUG-11-10
title: pageIndex=0 is accepted and returns the first page
type: happy
layer: functional
covers: ["Suggested fix: PageIndex >= 0", "Implementation Notes: pageIndex >= 0"]
priority: P2
---

# TC-BUG-11-10: pageIndex=0 is accepted and returns the first page

## Why

- Lower boundary just inside the limit for pageIndex (-1 is rejected, 0 must pass).

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageIndex=0&pageSize=5` anonymously.

## Expected result

- Status is `200`.
- Body has `pageIndex` 0, `pageSize` 5 and `data` with the first 5 items by the default ordering (the same items as the call without `pageIndex`).
