---
id: TC-BUG-15-04
title: Draft with items still returns 200 and the computed total
type: happy
layer: functional
covers: ["Code map: valid items return 200 OrderDraftDTO", "Deviations: the 200 JSON is unchanged"]
priority: P2
---

# TC-BUG-15-04: Draft with items still returns 200 and the computed total

## Why

- The endpoint's return type changed to `Results<Ok<OrderDraftDTO>, ValidationProblem>` and body binding changed to allow empty bodies. This regression case shows the success path and its JSON are unchanged and that no order is created. Functional layer because the response shape is what clients see.

## Preconditions

- Test stack running with scenario `ordering-two-buyers` loaded (`testing/teststack load ordering-two-buyers`).
- User alice (id `ALICE_ID` from the scenario) with a valid `ordering` token; alice has 6 orders.
- Basket items: product 2 "harness" unit price 89.99 quantity 2, and product 10 "Trailblazer Bike Helmet" unit price 59.99 quantity 1 (as in the existing e2e draft test).

## Steps

1. `POST http://localhost:18084/api/orders/draft?api-version=1.0` with alice's bearer token, `Content-Type: application/json` and body `{"buyerId": "<ALICE_ID>", "items": [<the two basket items above>]}`.
2. `GET http://localhost:18084/api/orders?api-version=1.0` with alice's token.

## Expected result

- Step 1: status `200`; `orderItems` has 2 entries; `orderItems[0]` matches `{productId: 2, units: 2, unitPrice: 89.99, discount: 0}`; `total` is 239.97 (2 decimals).
- Step 2: alice still has exactly 6 orders.
