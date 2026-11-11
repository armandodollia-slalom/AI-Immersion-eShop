---
id: TC-BUG-2-07
title: Admin can ship any buyer's Paid order
type: happy
layer: functional
covers: ["Ship allowed for role Admin", "Ship needs no ownership"]
priority: P0
---

# TC-BUG-2-07: Admin can ship any buyer's Paid order

## Why

- Positive counterpart of the role rule: the back-office role must still ship, including orders it does not own as a buyer.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- `admin` has a token with scope `orders` (obtained with `openid profile orders`).

## Steps

1. `PUT /api/orders/ship?api-version=1.0` with the admin token, a new `x-requestid`, body `{"orderNumber": 7}`.
2. `GET /api/orders/7?api-version=1.0` with bob's token.

## Expected result

- Step 1 returns `200`.
- Step 2 shows `status` `Shipped` and description "The order was shipped.".
