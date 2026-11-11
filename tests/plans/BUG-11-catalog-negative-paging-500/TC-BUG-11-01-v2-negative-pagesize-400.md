---
id: TC-BUG-11-01
title: GET v2 items with pageSize=-1 is 400 validation problem
type: sad
sad-path: validation
layer: functional
covers: ["Steps to Reproduce 1", "Expected: 400 BadRequest with a validation problem"]
priority: P1
---

# TC-BUG-11-01: GET v2 items with pageSize=-1 is 400 validation problem

## Why

- Reproduces step 1 of the bug: a negative LIMIT used to fail in Postgres with a 500. Functional because it needs the real database to prove Postgres is no longer reached.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageSize=-1` anonymously.

## Expected result

- Status is `400`; `Content-Type` contains `application/problem+json`.
- Body has `status` 400 and a non-empty `errors` object with an entry for `pageSize` (key compared case-insensitively); the story does not fix the message wording, so none is asserted.
- Response is not `500`; no `items`/`data` array is returned.
