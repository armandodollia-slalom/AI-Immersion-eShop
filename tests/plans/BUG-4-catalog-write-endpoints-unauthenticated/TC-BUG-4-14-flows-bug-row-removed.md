---
id: TC-BUG-4-14
title: Bug row is removed from the bugs table in testing/flows
type: happy
layer: unit
covers: ["Acceptance Criteria: matching row is removed from the bugs table in testing/flows/"]
priority: P2
---

# TC-BUG-4-14: Bug row is removed from the bugs table in testing/flows

## Why

- The story requires the flow documentation to stop listing this bug once fixed; a stale row would mislead later test-stack work. A file content check needs no running services.

## Preconditions

- Repository checkout with the fix applied.

## Steps

1. Search `testing/flows/` for the bugs-table row describing anonymous catalog create, update and delete (text "need no authentication" or "anonymous callers cannot create, update or delete").

## Expected result

- No row in any bugs table under `testing/flows/` describes catalog write endpoints being unauthenticated.
- `testing/flows/catalog.md` still exists.
