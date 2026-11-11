---
id: TC-BUG-8-02
title: INVALID_ARGUMENT message reports every invalid line
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: all invalid lines are reported in one INVALID_ARGUMENT message"]
priority: P2
---

# TC-BUG-8-02: INVALID_ARGUMENT message reports every invalid line

## Why

- The story decision says all invalid lines are reported together; a regression stopping at the first error would hide the second. Separate from TC-01 because it checks the message text, not only the status.

## Preconditions

- Test stack up with scenario `basket-edge`; alice has no basket. Token for alice with scope `basket`.

## Steps

1. As alice, call `UpdateBasket` with items `{productId: 7, quantity: -3}` and `{productId: 6, quantity: 0}`.

## Expected result

- Status `INVALID_ARGUMENT`.
- Status detail is `Invalid basket items: Product 7: Invalid number of units (-3); Product 6: Invalid number of units (0)`.
