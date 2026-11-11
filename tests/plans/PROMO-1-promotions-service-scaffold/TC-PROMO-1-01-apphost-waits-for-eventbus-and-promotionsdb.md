---
id: TC-PROMO-1-01
title: promotions-api references and waits for eventbus and promotionsdb
type: happy
layer: unit
covers: ["AC: AppHost resource model", "Inputs: AppHost registration WithReference/WaitFor"]
priority: P1
---

# TC-PROMO-1-01: promotions-api references and waits for eventbus and promotionsdb

## Why

- The scaffold's core wiring (own DB, event bus) must hold; WaitFor controls startup order, which the story says to check on the model rather than by timing. Unit layer per Test scope.

## Preconditions

- AppHost resource model built as in `tests/eShop.AppHost.UnitTests` (same builder setup as the existing tests).

## Steps

1. Build the distributed application model without starting it.
2. Find the project resource named `promotions-api`.

## Expected result

- The model contains a resource named `promotions-api`.
- It has a resource reference annotation to `eventbus` and one to `promotionsdb`.
- It has a wait annotation for `eventbus` and one for `promotionsdb`.
- Resource `promotionsdb` exists and its parent is the postgres server resource.
