---
id: TC-BUG-14-04
title: Typing a value and blurring without Enter commits it once
type: happy
layer: e2e
covers: ["Implementation Notes: typed value + blur still commits once via the change listener"]
priority: P2
---

# TC-BUG-14-04: Typing a value and blurring without Enter commits it once

## Why

- The fix must not break the existing commit-on-change path used without Enter. Counting POSTs confirms a single submit.

## Preconditions

- Test stack up with `basket-edge` loaded; bob's first cart line is the Explorer 45L Backpack (ProductId 7, seeded quantity 2) in `testing/scenarios/basket-edge/scenario.yaml`.

## Steps

1. Sign in as bob and open the cart and start recording POST requests to the cart page.
2. Fill `6` in the first line's quantity box (no Enter).
3. Click an empty area of the page to blur the box, and wait for the submit to finish.

## Expected result

- Exactly one POST is recorded, carrying quantity 6.
- The quantity box shows `6` and Redis holds quantity 6 for that product.
