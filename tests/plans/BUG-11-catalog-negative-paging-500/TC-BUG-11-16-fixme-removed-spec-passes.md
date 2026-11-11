---
id: TC-BUG-11-16
title: catalog-api.spec passes with the fixme marker removed
type: happy
layer: e2e
covers: ["Acceptance Criteria: test.fixme removed, test passes and file still passes"]
priority: P1
---

# TC-BUG-11-16: catalog-api.spec passes with the fixme marker removed

## Why

- Direct acceptance criterion; it also proves no other test in the file regressed (for example pageSize=0 and the 400s for `abc` and `1.5`).

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. Confirm `test.fixme` is removed from "negative pageSize or pageIndex is rejected with 400" in `e2e/teststack/catalog-api.spec.ts`.
2. Run `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/catalog-api.spec.ts`.

## Expected result

- The command exits 0; the test "negative pageSize or pageIndex is rejected with 400" is reported passed (not skipped/fixme).
- No other test in the file fails.
