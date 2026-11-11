---
id: TC-BUG-7-02
title: Cart page shows the valid line and omits the missing product
type: happy
layer: e2e
covers: ["Expected: cart drops the missing product, rest of basket shown", "Suggested fix: skip lines whose product is missing"]
priority: P1
---

# TC-BUG-7-02: Cart page shows the valid line and omits the missing product

## Why

- Not crashing is not enough: the story requires the rest of the basket to be shown. This is the cart-page check mirrored by the un-fixme'd spec; e2e because the cart rendering is the observable.

## Preconditions

- Test stack up, scenario `basket-edge` loaded; oscar's basket has product 7 (Explorer 45L Backpack) and product 99999.

## Steps

1. Sign in as `oscar` / `Pass123$`.
2. Open `http://localhost:18080/cart`.

## Expected result

- The cart page renders without an error.
- Exactly one cart line is shown: "Explorer 45L Backpack".
- No cart line other than "Explorer 45L Backpack" is rendered, so nothing is shown for product 99999.
