---
id: TC-BUG-4-09
title: Admin can update an item and the change persists
type: happy
layer: functional
covers: ["Expected: only an admin role can change the catalog", "Policy CatalogAdmin"]
priority: P0
---

# TC-BUG-4-09: Admin can update an item and the change persists

## Why

- Update is the write that publishes the price-changed event, so the admin path must still work end to end.

## Preconditions

- Test stack up, `catalog-edge` loaded; `admin` token as in TC-BUG-4-08; item 1 exists.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` with `Authorization: Bearer <admin token>` and a valid body for item 1 with price 999.99.

## Expected result

- Status 201 (the existing success status of this endpoint).
- Anonymous `GET /api/catalog/items/1?api-version=2.0` returns price 999.99.
