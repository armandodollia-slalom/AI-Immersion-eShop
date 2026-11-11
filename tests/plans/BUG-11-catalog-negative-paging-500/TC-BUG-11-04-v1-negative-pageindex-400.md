---
id: TC-BUG-11-04
title: GET v1 items with pageIndex=-1 is 400 validation problem
type: sad
sad-path: validation
layer: functional
covers: ["Acceptance Criteria: test.fixme test, pageIndex half", "Expected: 400"]
priority: P1
---

# TC-BUG-11-04: GET v1 items with pageIndex=-1 is 400 validation problem

## Why

- Same as the v1 pageSize case for the OFFSET side of the fixme test.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=1.0&pageIndex=-1` anonymously.

## Expected result

- Status is `400`; `Content-Type` contains `application/problem+json`.
- Body has `status` 400 and a non-empty `errors` object with an entry for `pageIndex` (key compared case-insensitively); the story does not fix the message wording, so none is asserted.
- Response is not `500`; no `items`/`data` array is returned.
