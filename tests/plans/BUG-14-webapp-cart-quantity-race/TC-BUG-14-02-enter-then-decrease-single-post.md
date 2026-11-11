---
id: TC-BUG-14-02
title: Enter then Decrease sends exactly one cart POST
type: sad
sad-path: concurrency
layer: e2e
covers: ["Technical Notes: the click blurs the input, firing change, which submits the typed value again in parallel with the decrement POST"]
priority: P1
---

# TC-BUG-14-02: Enter then Decrease sends exactly one cart POST

## Why

- The race is timing dependent, so TC-BUG-14-01 can pass by luck. Counting form POSTs after the Enter commit checks the root cause (the duplicate submit) deterministically. E2e is required for real focus and blur.

## Preconditions

- Test stack up with `basket-edge` loaded; bob's first cart line is the Explorer 45L Backpack (ProductId 7, seeded quantity 2) in `testing/scenarios/basket-edge/scenario.yaml`.

## Steps

1. Sign in as bob and open the cart.
2. Fill `5` in the first line's quantity box, press Enter, and wait for the submit to finish.
3. Start recording POST requests to the cart page.
4. Click that line's Decrease (−) button and wait for the UI to settle.

## Expected result

- Exactly one POST is recorded in step 4, and its submitter is the Decrease button (not the quantity apply submitter).
- No request in step 4 carries quantity 5.
- The quantity box shows `4`.
