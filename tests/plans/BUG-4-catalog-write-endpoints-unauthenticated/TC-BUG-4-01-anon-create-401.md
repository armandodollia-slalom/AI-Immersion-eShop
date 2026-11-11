---
id: TC-BUG-4-01
title: Anonymous POST create item is 401
type: sad
sad-path: auth
layer: functional
covers: ["Expected: 401 for anonymous callers", "Steps to Reproduce 1"]
priority: P0
---

# TC-BUG-4-01: Anonymous POST create item is 401

## Why

- Core of the bug: anonymous create returned 201, letting anyone add products. Functional layer because it needs the real API pipeline and auth middleware.

## Preconditions

- Test stack up, `catalog-edge` loaded. Note the current item count via anonymous `GET /api/catalog/items?api-version=2.0&pageIndex=0&pageSize=100` (`count`).

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with no `Authorization` header and a valid JSON item body (name "Anon item", price 10, valid catalogBrandId and catalogTypeId).

## Expected result

- Status 401.
- No item named "Anon item" exists afterwards; the `count` from the preconditions is unchanged.
