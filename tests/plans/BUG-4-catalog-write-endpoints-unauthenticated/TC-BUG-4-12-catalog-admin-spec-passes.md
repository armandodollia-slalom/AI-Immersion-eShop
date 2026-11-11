---
id: TC-BUG-4-12
title: catalog-admin spec passes with the anonymous test enabled
type: happy
layer: e2e
covers: ["Acceptance Criteria: test.fixme removed and the rest of the file still passes"]
priority: P1
---

# TC-BUG-4-12: catalog-admin spec passes with the anonymous test enabled

## Why

- The story's acceptance criterion; proves existing admin write tests work with an admin bearer token and the anonymous test now passes.

## Preconditions

- `testing/teststack up`, `testing/teststack load catalog-edge` (scenario contains the `Admin` role and `admin` user); `test.fixme` removed from "anonymous callers cannot create, update or delete items" in `e2e/teststack/catalog-admin.spec.ts`; write tests send an admin bearer token.

## Steps

1. Run `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/catalog-admin.spec.ts`.

## Expected result

- Exit code 0; "anonymous callers cannot create, update or delete items" is reported as passed (not skipped/fixme); no other test in the file fails.
