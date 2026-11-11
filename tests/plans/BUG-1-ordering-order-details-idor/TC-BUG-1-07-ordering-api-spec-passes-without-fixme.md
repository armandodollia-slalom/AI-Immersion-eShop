---
id: TC-BUG-1-07
title: Ordering API spec passes with the fixme removed from the order-details test
type: happy
layer: functional
covers: ["Acceptance Criteria: test.fixme removed and the rest of the file still passes"]
priority: P1
---

# TC-BUG-1-07: Ordering API spec passes with the fixme removed from the order-details test

## Why

- The second acceptance criterion requires the regression test to be active and green, and the other tests in the file to stay green. Without it the fix could regress unnoticed. Functional layer because the spec runs against the test stack.

## Preconditions

- Test stack up (`testing/teststack up`).
- `e2e/teststack/ordering-api.spec.ts` contains no `test.fixme` marker on "a buyer cannot read another buyer's order details".

## Steps

1. Run `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/ordering-api.spec.ts`.

## Expected result

- The command exits with code 0.
- "a buyer cannot read another buyer's order details" is reported as passed, not skipped.
- No test in the file fails.
