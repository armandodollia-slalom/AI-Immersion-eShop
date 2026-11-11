---
id: TC-BUG-4-03
title: Anonymous PUT v1 update item is 401
type: sad
sad-path: auth
layer: functional
covers: ["Technical Notes: UpdateItemV1 mapped without RequireAuthorization"]
priority: P0
---

# TC-BUG-4-03: Anonymous PUT v1 update item is 401

## Why

- The v1 update is a separate route (`UpdateItemV1`) that could be missed when securing v2; a gap would leave a bypass.

## Preconditions

- Test stack up, `catalog-edge` loaded; item 1 exists with a recorded price.

## Steps

1. `PUT http://localhost:18082/api/catalog/items?api-version=1.0` with no `Authorization` header and a body containing id 1 and price 999.99.

## Expected result

- Status 401.
- Item 1 still has its recorded price.
