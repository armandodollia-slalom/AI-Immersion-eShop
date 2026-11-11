---
id: TC-BUG-14-05
title: Basket cart spec passes with the fixme marker removed
type: happy
layer: e2e
covers: ["Acceptance criterion 2: test.fixme removed, the test and the rest of the file pass"]
priority: P1
---

# TC-BUG-14-05: Basket cart spec passes with the fixme marker removed

## Why

- The story requires the previously fixme'd test to pass and no other test in the file (clamping, typing, remove, persistence) to regress from the change to the shared quantity script.

## Preconditions

- Test stack up with `basket-edge` loaded; `test.fixme` changed to `test` on "typing a quantity, pressing Enter, then clicking Decrease reliably stores the decremented quantity" in `e2e/teststack/basket-cart.spec.ts`.

## Steps

1. Run `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/basket-cart.spec.ts`.

## Expected result

- Exit code 0; every test in the file passes, including the formerly fixme'd test; zero tests are skipped as fixme.
