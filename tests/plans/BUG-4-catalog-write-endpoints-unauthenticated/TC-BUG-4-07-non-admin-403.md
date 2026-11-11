---
id: TC-BUG-4-07
title: Authenticated non-admin user gets 403 on write
type: sad
sad-path: auth
layer: functional
covers: ["Expected: only an admin role can change the catalog", "Policy CatalogAdmin"]
priority: P0
---

# TC-BUG-4-07: Authenticated non-admin user gets 403 on write

## Why

- Authentication alone must not be enough; the policy requires role `Admin`. Without this case a fix that only requires any valid token would pass.

## Preconditions

- Test stack up, `catalog-edge` loaded; user alice (no `Admin` role) obtains a valid access token with scope `catalog`; item 1 exists with a recorded price.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` with `Authorization: Bearer <alice token>` and a valid body with price 999.99.
2. `POST /api/catalog/items?api-version=2.0` with the same bearer token and a valid item.
3. `DELETE /api/catalog/items/1?api-version=2.0` with the same bearer token.

## Expected result

- Each step returns 403.
- Item 1 still exists with its recorded price; no new item was created.
