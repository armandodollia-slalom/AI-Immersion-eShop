---
id: TC-BUG-4-02
title: Anonymous PUT v2 update item is 401
type: sad
sad-path: auth
layer: functional
covers: ["Expected: 401 for anonymous callers", "Steps to Reproduce 2", "Technical Notes: UpdateItem"]
priority: P0
---

# TC-BUG-4-02: Anonymous PUT v2 update item is 401

## Why

- Anonymous update changed prices and published a price event. Separate case from create because it is a different endpoint registration (`UpdateItem`).

## Preconditions

- Test stack up, `catalog-edge` loaded; item 1 exists. Record its name and price via anonymous GET.

## Steps

1. `PUT http://localhost:18082/api/catalog/items/1?api-version=2.0` with no `Authorization` header and a valid body for item 1 (id 1, price changed to 999.99).

## Expected result

- Status 401.
- Item 1 still has its recorded price.
