---
id: TC-BUG-14-03
title: Typing a new value after Enter and blurring still commits it
type: sad
sad-path: conflict
layer: e2e
covers: ["Implementation Notes: any input event clears the committed mark, so typing a new value and blurring still commits it"]
priority: P2
---

# TC-BUG-14-03: Typing a new value after Enter and blurring still commits it

## Why

- A too-broad fix (ignoring all blur changes after Enter) would silently drop a later typed value. This guards that regression; it needs a real blur, so e2e.

## Preconditions

- Test stack up with `basket-edge` loaded; bob's first cart line is the Explorer 45L Backpack (ProductId 7, seeded quantity 2) in `testing/scenarios/basket-edge/scenario.yaml`.

## Steps

1. Sign in as bob and open the cart.
2. Fill `5` in the first line's quantity box, press Enter, wait for the submit to finish.
3. Type `7` into the same box (no Enter).
4. Click an empty area of the page to blur the box, and wait for the submit to finish.

## Expected result

- The quantity box shows `7`.
- Redis holds quantity 7 for that product.
