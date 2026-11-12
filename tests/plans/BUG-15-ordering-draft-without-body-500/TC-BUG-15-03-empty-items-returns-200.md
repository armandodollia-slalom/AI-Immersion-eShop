---
id: TC-BUG-15-03
title: Draft with items [] still returns 200 and an empty draft
type: happy
layer: functional
covers: ["Decisions: items [] stays valid and returns an empty draft with total 0"]
priority: P1
---

# TC-BUG-15-03: Draft with items [] still returns 200 and an empty draft

## Why

- The story deliberately did not reject empty `Items` (the Technical Notes suggested it) because the existing draft test relies on it. This case guards the boundary between null (400) and empty (200) so a later over-eager validation is caught. Functional layer, same reason as TC-BUG-15-01.

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`).
- User alice (id `ALICE_ID` from the scenario) with a valid `ordering` token; alice has 6 orders.

## Steps

1. `POST http://localhost:18084/api/orders/draft?api-version=1.0` with alice's bearer token, `Content-Type: application/json` and body `{"buyerId": "<ALICE_ID>", "items": []}`.

## Expected result

- Status `200`; body equals `{"orderItems": [], "total": 0}`.
