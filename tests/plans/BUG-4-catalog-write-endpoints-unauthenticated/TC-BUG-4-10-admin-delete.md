---
id: TC-BUG-4-10
title: Admin can delete an item
type: happy
layer: functional
covers: ["Expected: only an admin role can change the catalog", "Policy CatalogAdmin"]
priority: P0
---

# TC-BUG-4-10: Admin can delete an item

## Why

- Ensures the delete endpoint still works for admins after authorization was added.

## Preconditions

- Test stack up, `catalog-edge` loaded; `admin` token as in TC-BUG-4-08; an item created by the admin (id X) exists.

## Steps

1. `DELETE http://localhost:18082/api/catalog/items/X?api-version=2.0` with `Authorization: Bearer <admin token>`.

## Expected result

- Status 204.
- Anonymous `GET /api/catalog/items/X?api-version=2.0` returns 404.
