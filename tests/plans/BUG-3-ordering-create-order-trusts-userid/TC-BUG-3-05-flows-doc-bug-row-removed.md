---
id: TC-BUG-3-05
title: Bug row for create-order trusting the body userId is removed from testing/flows/ordering.md
type: happy
layer: unit
covers: ["Acceptance Criteria 3: matching row removed from the bugs table in testing/flows/"]
priority: P3
---

# TC-BUG-3-05: Bug row for create-order trusting the body userId is removed from testing/flows/ordering.md

## Why

- The third acceptance criterion requires the flow docs to stop listing a fixed bug as known. Static repository check, no running services needed.

## Preconditions

- Repository checked out on the fix branch.

## Steps

1. Open the "Known issues" table in `testing/flows/ordering.md`.
2. Open the flow row "`userId` in the body cannot place an order for another buyer" and the spec counts at the top of the file.

## Expected result

- The "Known issues" table has no row about create order using the body `userId`.
- The flow row for that test carries no `**fixme**` marker.
- The `ordering-api.spec.ts` row counts one more pass and one fewer fixme than before (15 pass, 4 fixme).
