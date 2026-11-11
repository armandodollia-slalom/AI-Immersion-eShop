---
id: TC-BUG-5-07
title: auth-login spec passes with the test.fixme marker removed
type: happy
layer: e2e
covers: ["Acceptance: marker removed, test passes, rest of file passes"]
priority: P1
---

# TC-BUG-5-07: auth-login spec passes with the test.fixme marker removed

## Why

- Acceptance criterion: the regression test is live and the whole file stays green.

## Preconditions

- Test stack up with the `auth-lockout` scenario loaded.

## Steps

1. Confirm `e2e/teststack/auth-login.spec.ts` has no `test.fixme` on "a protocol-relative returnUrl on /user/login must not redirect off-site".
2. Run `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/auth-login.spec.ts`.

## Expected result

- The protocol-relative test is executed (not skipped) and passes.
- Every other test in the file passes; exit code 0.
