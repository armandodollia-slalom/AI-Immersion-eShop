---
id: TC-BUG-17-02
title: Validation problem identifies the missing name field
type: sad
sad-path: validation
layer: functional
covers: ["Expected: validation problem", "Technical Notes: field-keyed errors"]
priority: P2
---

# TC-BUG-17-02: Validation problem identifies the missing name field

## Why

- A validation problem is only useful if it tells the caller which field failed; the fix returns field-keyed errors. Separate from 01 so a generic 400 without field detail is caught.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded; admin token.

## Steps

1. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with the body from TC-BUG-17-01 (no `name`).

## Expected result

- Status 400.
- The `errors` object has a key equal to `name` (case-insensitive) whose value is a non-empty array of strings.
- `errors` has no keys for the other, valid fields.
