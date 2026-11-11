---
id: TC-BUG-11-06
title: Mobile BFF route with pageIndex=-1 is 400 validation problem
type: sad
sad-path: validation
layer: functional
covers: ["Steps to Reproduce: mobile BFF behaves the same"]
priority: P1
---

# TC-BUG-11-06: Mobile BFF route with pageIndex=-1 is 400 validation problem

## Why

- Same as the BFF pageSize case for pageIndex.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.
- The BFF route is the `/catalog-api` prefix route documented in `testing/flows/catalog.md` (Mobile BFF catalog flows) and used as `PREFIXED` in `e2e/teststack/catalog-mobile-bff.spec.ts`: `http://localhost:18087/catalog-api/api/catalog/...`, prefix stripped before reaching Catalog.API.

## Steps

1. `GET http://localhost:18087/catalog-api/api/catalog/items?api-version=2.0&pageIndex=-1` anonymously.

## Expected result

- Status is `400`; `Content-Type` contains `application/problem+json`.
- Body has `status` 400 and a non-empty `errors` object with an entry for `pageIndex` (key compared case-insensitively); no message wording is asserted.
- Response is not `500` or `502`.
