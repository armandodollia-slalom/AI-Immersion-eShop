---
id: TC-BUG-11-02
title: GET v2 items with pageIndex=-1 is 400 validation problem
type: sad
sad-path: validation
layer: functional
covers: ["Steps to Reproduce 2", "Expected: 400 BadRequest with a validation problem"]
priority: P1
---

# TC-BUG-11-02: GET v2 items with pageIndex=-1 is 400 validation problem

## Why

- Reproduces step 2: a negative OFFSET used to cause a 500. Separate from the pageSize case because it is a different parameter and a different error key.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageIndex=-1` anonymously.

## Expected result

- Status is `400`; `Content-Type` contains `application/problem+json`.
- Body has `status` 400 and a non-empty `errors` object with an entry for `pageIndex` (key compared case-insensitively); the story does not fix the message wording, so none is asserted.
- Response is not `500`; no `items`/`data` array is returned.
