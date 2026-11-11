---
id: TC-BUG-4-06
title: Invalid bearer token on write is 401
type: sad
sad-path: auth
layer: functional
covers: ["Expected: 401 for unauthenticated callers", "AddDefaultAuthentication"]
priority: P1
---

# TC-BUG-4-06: Invalid bearer token on write is 401

## Why

- Proves the JWT bearer validation is actually wired in Catalog.API, not just a presence check on the header.

## Preconditions

- Test stack up, `catalog-edge` loaded; item 1 exists.

## Steps

1. `DELETE http://localhost:18082/api/catalog/items/1?api-version=2.0` with header `Authorization: Bearer not-a-real-token`.

## Expected result

- Status 401.
- Anonymous `GET /api/catalog/items/1?api-version=2.0` still returns 200.
