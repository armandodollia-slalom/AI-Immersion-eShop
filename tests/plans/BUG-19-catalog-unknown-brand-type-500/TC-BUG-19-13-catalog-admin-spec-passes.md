---
id: TC-BUG-19-13
title: catalog-admin spec passes with the fixme marker removed and the flows bug row is gone
type: happy
layer: e2e
covers: ["Acceptance: test.fixme removed and spec passes", "Acceptance: bugs table row removed in testing/flows/"]
priority: P1
---

# TC-BUG-19-13: catalog-admin spec passes with the fixme marker removed and the flows bug row is gone

## Why

- The acceptance criteria require the spec to pass unmarked, with the rest of the file still passing, and the bug row removed. It is the end-to-end verification that the fix matches the automated reproduction.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded.
- `test.fixme` removed from "unknown brand or type ids are rejected with 400" in `e2e/teststack/catalog-admin.spec.ts` (and from "v2 PUT with an unknown type id is 400" if marked).

## Steps

1. `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps e2e/teststack/catalog-admin.spec.ts`.
2. Search `testing/flows/` for the BUG-19 / unknown brand or type row in the bugs table.

## Expected result

- Step 1 exits 0 with every test in the file passed, including "unknown brand or type ids are rejected with 400", and none skipped as fixme for this bug.
- Step 2 finds no bugs-table row for unknown brand or type ids returning 500.
