---
id: TC-BUG-2-12
title: ordering-api spec passes with the fixme removed
type: happy
layer: functional
covers: ["AC 2: fixme removed, test passes, rest of the file passes"]
priority: P1
---

# TC-BUG-2-12: ordering-api spec passes with the fixme removed

## Why

- Acceptance criterion 2. The spec's other tests ship with alice's token and need the admin token now; this case makes that a checked requirement.

## Preconditions

- Test stack up, `testing/teststack load ordering-two-buyers` loaded (alice = buyer 1 owns orders 1-6, bob = buyer 2 owns Paid order 7 and Shipped order 8, user `admin` has role `Admin`; all passwords `Pass123$`).
- The `test.fixme` line is removed from `a buyer cannot cancel or ship another buyer's order`; the other cancel/ship tests in the file use the admin token for ship.

## Steps

1. Run `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/ordering-api.spec.ts`.

## Expected result

- Exit code 0; "a buyer cannot cancel or ship another buyer's order" is reported passed (not fixme/skipped).
- No other test in the file fails.
