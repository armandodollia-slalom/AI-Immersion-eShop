---
id: TC-BUG-4-08
title: Admin can create an item
type: happy
layer: functional
covers: ["Expected: only an admin role can change the catalog", "Policy CatalogAdmin"]
priority: P0
---

# TC-BUG-4-08: Admin can create an item

## Why

- Ensures the fix did not lock out legitimate admins; creation is the first of the three writes.

## Preconditions

- Test stack up, `catalog-edge` loaded; user `admin` (password `Pass123$`, role `Admin`) obtains an access token with scope `catalog`.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` with `Authorization: Bearer <admin token>` and a valid item body (name "Admin item", price 10, valid brand and type ids).

## Expected result

- Status 201.
- Anonymous `GET /api/catalog/items?api-version=2.0&pageIndex=0&pageSize=100` lists an item named "Admin item".
