---
id: TC-BUG-2-13
title: Bug row removed from testing/flows/ordering.md
type: happy
layer: unit
covers: ["AC 3: matching row removed from the bugs table in testing/flows/"]
priority: P3
---

# TC-BUG-2-13: Bug row removed from testing/flows/ordering.md

## Why

- Acceptance criterion 3, a static repository check.

## Preconditions

- Repository checked out on the fix branch.

## Steps

1. Open `testing/flows/ordering.md`: the Known issues table and the Cancel and ship table.

## Expected result

- Known issues has no row about cancel/ship ownership.
- The row "A buyer cannot cancel or ship another buyer's order" has no `**fixme**` marker, and the spec counts at the top of the file reflect one more pass and one fewer fixme.
