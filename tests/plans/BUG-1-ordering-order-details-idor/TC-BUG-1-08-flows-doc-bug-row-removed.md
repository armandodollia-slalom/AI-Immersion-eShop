---
id: TC-BUG-1-08
title: Bug row for the order-details IDOR is removed from testing/flows/ordering.md
type: happy
layer: unit
covers: ["Acceptance Criteria: matching row removed from the bugs table in testing/flows/"]
priority: P3
---

# TC-BUG-1-08: Bug row for the order-details IDOR is removed from testing/flows/ordering.md

## Why

- The third acceptance criterion requires the flow docs to stop listing a fixed bug as known. A stale row misleads later test work. It is a static repository check, so no running services are needed.

## Preconditions

- Repository checked out on the fix branch.

## Steps

1. Open the "Known issues" table in `testing/flows/ordering.md`.
2. Open the flow table row for "a buyer cannot read another buyer's order details" and the spec counts at the top of the file.

## Expected result

- The "Known issues" table has no row about any buyer reading another buyer's order by id.
- The flow row for that test no longer carries a `**fixme**` marker.
- The `ordering-api.spec.ts` row in the spec table counts one fewer fixme and one more pass than before (14 pass, 5 fixme becomes 15 pass, 4 fixme).
