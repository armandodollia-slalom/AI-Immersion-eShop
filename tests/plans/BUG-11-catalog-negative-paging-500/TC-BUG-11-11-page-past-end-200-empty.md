---
id: TC-BUG-11-11
title: Page index past the end still returns 200 with an empty page
type: happy
layer: functional
covers: ["Implementation Notes: a page past the end still returns 200 with an empty page"]
priority: P2
---

# TC-BUG-11-11: Page index past the end still returns 200 with an empty page

## Why

- Guards against the new validation also rejecting large valid indexes; the decision log states this must stay 200.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=1.0&pageIndex=100` anonymously.

## Expected result

- Status is `200`.
- Body has `pageIndex` 100, `pageSize` 10, `count` equal to the total item count and `data` equal to `[]`.
