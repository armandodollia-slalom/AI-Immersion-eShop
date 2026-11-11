---
id: TC-BUG-8-07
title: An update with no items is still accepted
type: happy
layer: functional
covers: ["Implementation Notes: empty baskets stay valid"]
priority: P2
---

## TC-BUG-8-07: An update with no items is still accepted

## Why

- The fix must not treat an empty item list as invalid; this existing behavior could regress if validation required at least one line.

## Preconditions

- Test stack up with scenario `basket-edge`; alice has no basket. Token for alice with scope `basket`.

## Steps

1. As alice, call `UpdateBasket` with no items.
2. Cleanup: call `DeleteBasket` as alice.

## Expected result

- Status `OK`; response has zero items.
