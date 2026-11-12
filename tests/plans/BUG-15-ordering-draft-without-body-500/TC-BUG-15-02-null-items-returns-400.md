---
id: TC-BUG-15-02
title: Draft with items null is rejected with 400 on the Items key
type: sad
sad-path: validation
layer: functional
covers: ["Decisions: items null is rejected", "Code map: items null returns 400 ValidationProblem (key Items)"]
priority: P1
---

# TC-BUG-15-02: Draft with items null is rejected with 400 on the Items key

## Why

- The fix has a second rejection branch (body present, `Items` null) that the bodyless case does not reach. Without it a null list would still fail with a 500 further down. Functional layer, same reason as TC-BUG-15-01.

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`).
- User alice (id `ALICE_ID` from the scenario) with a valid `ordering` token; alice has 6 orders.

## Steps

1. `POST http://localhost:18084/api/orders/draft?api-version=1.0` with alice's bearer token, `Content-Type: application/json` and body `{"buyerId": "<ALICE_ID>", "items": null}`.

## Expected result

- Status `400` (not 500); content type `application/problem+json`; body `status` is `400`.
- `errors` has the key `Items` with exactly one non-empty message, and no other keys.
