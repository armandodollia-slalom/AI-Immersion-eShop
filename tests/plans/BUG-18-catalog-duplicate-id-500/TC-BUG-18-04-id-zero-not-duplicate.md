---
id: TC-BUG-18-04
title: Create with id 0 is not treated as a duplicate
type: sad
sad-path: boundary
layer: functional
covers: ["Decisions: id 0 or below still lets the database generate the id"]
priority: P2
---

# TC-BUG-18-04: Create with id 0 is not treated as a duplicate

## Why

- The existence check applies only to ids above 0, so `0` (the default a client gets by serializing an unset int) is the boundary just outside it. The risk is a check that treats 0 as a real id and returns 409. Functional, against the real database.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded; admin token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with the body from TC-BUG-18-01 but `"id": 0`.

## Expected result

- Status is 201.
- The `Location` header is `/api/catalog/items/<id>` where `<id>` is greater than 14.
