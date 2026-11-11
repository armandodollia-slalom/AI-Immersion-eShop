---
id: TC-BUG-4-13
title: Admin can update an item through the v1 route and the change persists
type: happy
layer: functional
covers: ["Technical Notes: UpdateItemV1 got RequireAuthorization", "Expected: only an admin role can change the catalog"]
priority: P1
---

# TC-BUG-4-13: Admin can update an item through the v1 route and the change persists

## Why

- `UpdateItemV1` is a separate route that also received `RequireAuthorization("CatalogAdmin")`; TC-BUG-4-03 only proves it rejects anonymous callers, so this proves the policy still lets an admin through.

## Preconditions

- Test stack up, `catalog-edge` loaded; `admin` token as in TC-BUG-4-08; item 1 exists.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` with `Authorization: Bearer <admin token>` and a valid body with id 1 and price 888.88.
2. `GET http://localhost:18082/api/catalog/items/1?api-version=2.0` with no `Authorization` header.

## Expected result

- Step 1 returns 201 (the existing success status of this endpoint).
- Step 2 returns price 888.88.
