---
id: TC-BUG-11-12
title: Negative pageSize and pageIndex together are rejected with 400
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest with a validation problem", "Steps to Reproduce 1 and 2 combined"]
priority: P2
---

# TC-BUG-11-12: Negative pageSize and pageIndex together are rejected with 400

## Why

- Both bad values in one request must still produce a 400 validation problem and not a 500 from either LIMIT or OFFSET.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageSize=-1&pageIndex=-1` anonymously.

## Expected result

- Status is `400`; `Content-Type` contains `application/problem+json`.
- Body has `status` 400 and a non-empty `errors` object with at least one entry for `pageSize` or `pageIndex` (key compared case-insensitively); the story does not fix the message wording, so none is asserted.
- Response is not `500`; no `items`/`data` array is returned.
