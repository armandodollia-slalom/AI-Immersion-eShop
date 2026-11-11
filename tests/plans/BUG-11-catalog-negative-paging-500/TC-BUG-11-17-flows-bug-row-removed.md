---
id: TC-BUG-11-17
title: Bug row removed from the bugs table in testing/flows/catalog.md
type: happy
layer: unit
covers: ["Acceptance Criteria: matching row removed from bugs table in testing/flows/"]
priority: P3
---

# TC-BUG-11-17: Bug row removed from the bugs table in testing/flows/catalog.md

## Why

- Documentation acceptance criterion; a stale row would keep reporting a fixed bug. Checked by file inspection, no running services.

## Preconditions

- Repository checkout of the branch.

## Steps

1. Run `grep -n -i "negative" testing/flows/*.md`.

## Expected result

- The bugs table in `testing/flows/catalog.md` has no row about negative `pageSize`/`pageIndex` returning 500.
- Any remaining mention of negative paging in the List items flow describes the 400 response.
