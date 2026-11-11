---
id: TC-BUG-11-03
title: GET v1 items with pageSize=-1 is 400 validation problem
type: sad
sad-path: validation
layer: functional
covers: ["Acceptance Criteria: test.fixme test, pageSize half", "Expected: 400"]
priority: P1
---

# TC-BUG-11-03: GET v1 items with pageSize=-1 is 400 validation problem

## Why

- The v1 route has its own handler (`GetAllItemsV1`) and is the one the fixme e2e test calls; the filter must be applied to it too.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=1.0&pageSize=-1` anonymously.

## Expected result

- Status is `400`; `Content-Type` contains `application/problem+json`.
- Body has `status` 400 and a non-empty `errors` object with an entry for `pageSize` (key compared case-insensitively); the story does not fix the message wording, so none is asserted.
- Response is not `500`; no `items`/`data` array is returned.
