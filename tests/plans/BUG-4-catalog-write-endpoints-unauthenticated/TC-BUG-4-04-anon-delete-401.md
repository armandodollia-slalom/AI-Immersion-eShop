---
id: TC-BUG-4-04
title: Anonymous DELETE item is 401
type: sad
sad-path: auth
layer: functional
covers: ["Expected: 401 for anonymous callers", "Steps to Reproduce 2"]
priority: P0
---

# TC-BUG-4-04: Anonymous DELETE item is 401

## Why

- Anonymous delete returned 204, so anyone could remove products. Separate endpoint registration (`DeleteItemById`).

## Preconditions

- Test stack up, `catalog-edge` loaded; item 1 exists.

## Steps

1. `DELETE http://localhost:18082/api/catalog/items/1?api-version=2.0` with no `Authorization` header.

## Expected result

- Status 401.
- Anonymous `GET /api/catalog/items/1?api-version=2.0` still returns 200.
