---
id: TC-BUG-12-09
title: Bug row removed from the bugs table in testing/flows/
type: happy
layer: unit
covers: ["Acceptance Criteria 3: matching row removed from bugs table in testing/flows/"]
priority: P3
---

# TC-BUG-12-09: Bug row removed from the bugs table in testing/flows/

## Why

- Documentation acceptance criterion; a stale row would keep reporting a fixed bug. File inspection, no services needed.

## Preconditions

- Repository checkout of the branch.

## Steps

1. Run `grep -n -i "page=0\|page=-1" testing/flows/*.md`.

## Expected result

- The bugs table in `testing/flows/catalog.md` has no row about `?page=0` or `?page=-1` not loading.
- Any remaining mention describes the pages as treated as page 1.
