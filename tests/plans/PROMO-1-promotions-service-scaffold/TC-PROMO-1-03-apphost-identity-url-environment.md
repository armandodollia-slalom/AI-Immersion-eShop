---
id: TC-PROMO-1-03
title: promotions-api gets the Identity__Url environment variable
type: happy
layer: unit
covers: ["AC: AppHost resource model", "Inputs: WithEnvironment(\"Identity__Url\", identityEndpoint)"]
priority: P1
---

# TC-PROMO-1-03: promotions-api gets the Identity__Url environment variable

## Why

- AddDefaultAuthentication reads `Identity:Url` to validate tokens; without the variable `GET /api/promotions` could never return 200 under Aspire. Unit layer per Test scope.

## Preconditions

- AppHost resource model built as in `tests/eShop.AppHost.UnitTests`.

## Steps

1. Build the model.
2. Evaluate the environment callbacks of `promotions-api`.

## Expected result

- The environment contains key `Identity__Url`.
- Its value is the same Identity endpoint value that `ordering-api` receives for `Identity__Url`.
