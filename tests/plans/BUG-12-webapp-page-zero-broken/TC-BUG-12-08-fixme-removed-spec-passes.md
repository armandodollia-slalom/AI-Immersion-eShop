---
id: TC-BUG-12-08
title: Un-fixme'd spec and the rest of catalog-browse pass
type: happy
layer: e2e
covers: ["Acceptance Criteria 2: test.fixme removed, file still passes"]
priority: P1
---

# TC-BUG-12-08: Un-fixme'd spec and the rest of catalog-browse pass

## Why

- Acceptance criterion names this command explicitly; ensures the previously fixme'd tests run and the other tests in the file are not broken by the change.

## Preconditions

- Test stack running with the `catalog-edge` scenario loaded (`testing/teststack up`, `testing/teststack load catalog-edge`): 14 products named Edge 01..14, sorted by name, 9 per page, so 2 pages.
- Anonymous browser session, WebApp at `http://localhost:18080`.
- `e2e/teststack/catalog-browse.spec.ts` contains no `test.fixme` for the `?page=...` first-page tests.

## Steps

1. Run `grep -n "fixme" e2e/teststack/catalog-browse.spec.ts`.
2. Run `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/catalog-browse.spec.ts`.

## Expected result

- Step 1 prints no `fixme` line for the "?page=0 shows the first page" or "?page=-1 shows the first page" tests.
- Step 2 exits 0; the `?page=0` and `?page=-1` tests are reported as passed (not skipped) and no test in the file fails.
