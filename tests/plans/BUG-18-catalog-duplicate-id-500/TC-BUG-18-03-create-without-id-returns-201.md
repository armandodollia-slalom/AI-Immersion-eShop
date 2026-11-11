---
id: TC-BUG-18-03
title: Create without an id still returns 201 with a generated id
type: happy
layer: functional
covers: ["Fix must not break valid create", "Decisions: database generates the id when none is given"]
priority: P1
---

# TC-BUG-18-03: Create without an id still returns 201 with a generated id

## Why

- The new existence check must only fire for client-supplied ids. The risk is a regression that rejects every create. Functional, because the generated id comes from the database.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded; admin token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with the body from TC-BUG-18-01 but without the `id` field.
2. Take the id from the `Location` header and call `GET http://localhost:18082/api/catalog/items/<id>?api-version=1.0`.

## Expected result

- Step 1 returns 201 and a `Location` header of the form `/api/catalog/items/<id>` where `<id>` is greater than 14.
- Step 2 returns 200 with `name` equal to "Edge 15 New Lantern".
