---
id: TC-BUG-11-09
title: pageSize=0 stays accepted and returns an empty page
type: happy
layer: functional
covers: ["Implementation Notes: pageSize lower bound is 0, not 1"]
priority: P1
---

# TC-BUG-11-09: pageSize=0 stays accepted and returns an empty page

## Why

- The decision deliberately deviates from the suggested fix (1..100) because an existing teststack test expects pageSize=0 to return an empty page; this guards against regressing to 1.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=1.0&pageSize=0` anonymously.

## Expected result

- Status is `200`.
- Body has `pageIndex` 0, `pageSize` 0, `count` equal to the total item count and `data` equal to `[]`.
