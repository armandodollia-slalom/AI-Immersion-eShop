---
id: TC-BUG-5-08
title: Bug row removed from the bugs table in testing/flows
type: happy
layer: unit
covers: ["Acceptance: matching row removed from testing/flows"]
priority: P3
---

# TC-BUG-5-08: Bug row removed from the bugs table in testing/flows

## Why

- Acceptance criterion about documentation; checkable without running services.

## Preconditions

- Repository checkout of the fix branch.

## Steps

1. Search `testing/flows/` for a bugs-table row about the protocol-relative returnUrl open redirect.

## Expected result

- No bugs-table row describing the protocol-relative returnUrl open redirect remains in `testing/flows/`.
