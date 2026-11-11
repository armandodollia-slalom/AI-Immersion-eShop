---
id: TC-BUG-14-06
title: Bugs table in testing/flows has no row for this bug
type: happy
layer: unit
covers: ["Acceptance criterion 3: the matching row is removed from the bugs table in testing/flows/"]
priority: P3
---

# TC-BUG-14-06: Bugs table in testing/flows has no row for this bug

## Why

- The story requires the bug's row to be removed from the flows bugs table so the doc no longer lists a fixed bug. It is a static file check, so no running services are needed (unit layer).

## Preconditions

- The branch checkout; no test stack needed.

## Steps

1. Read the `## Bugs found` table in `testing/flows/identity-basket.md`.
2. Search every file in `testing/flows/` for a bugs-table row (a line starting with `|`) whose Test column mentions `typing a quantity, pressing Enter, then clicking Decrease reliably stores the decremented quantity`.

## Expected result

- No bugs-table row in any `testing/flows/*.md` file contains that test title.
- The `## Bugs found` table in `identity-basket.md` still has its three other rows (open redirect, zero/negative quantities, basket scope).
- The "Covered by" line of the cart flow in `identity-basket.md` still lists the test (it is documentation of coverage, not a bugs-table row).
