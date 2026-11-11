---
id: TC-BUG-11-07
title: pageSize=101 is rejected with 400
type: sad
sad-path: boundary
layer: functional
covers: ["Implementation Notes: pageSize 0..100", "Suggested fix: PageSize upper bound 100"]
priority: P1
---

# TC-BUG-11-07: pageSize=101 is rejected with 400

## Why

- Just outside the upper limit; without this a large page size could still be abused. Paired with the pageSize=100 case.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageSize=101` anonymously.

## Expected result

- Status is `400`; `Content-Type` contains `application/problem+json`.
- Body has `status` 400 and a non-empty `errors` object with an entry for `pageSize` (key compared case-insensitively); the story does not fix the message wording, so none is asserted.
- Response is not `500`; no `items`/`data` array is returned.
