---
id: TC-BUG-11-08
title: pageSize=100 is accepted
type: happy
layer: functional
covers: ["Implementation Notes: pageSize 0..100"]
priority: P2
---

# TC-BUG-11-08: pageSize=100 is accepted

## Why

- Just inside the upper limit, so the validation is not off by one.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageSize=100` anonymously.

## Expected result

- Status is `200`.
- Body has `pageSize` 100, `pageIndex` 0 and `count` equal to the total catalog item count; `data` has `min(count, 100)` items.
