---
id: TC-PROMO-1-04
title: webapp and ordering-api reference promotions-api
type: happy
layer: unit
covers: ["AC: AppHost resource model", "Inputs: webApp.WithReference(promotionsApi); orderingApi.WithReference(promotionsApi)"]
priority: P1
---

# TC-PROMO-1-04: webapp and ordering-api reference promotions-api

## Why

- Other teams build on Promotions from Day 1 through these references; `orderingApi` is declared before `promotionsApi`, so a missed or misordered statement is a real risk. Unit layer per Test scope.

## Preconditions

- AppHost resource model built as in `tests/eShop.AppHost.UnitTests`.

## Steps

1. Build the model.
2. Read the resource reference annotations of `webapp` and of `ordering-api`.

## Expected result

- `webapp` has a reference to `promotions-api`.
- `ordering-api` has a reference to `promotions-api`.
