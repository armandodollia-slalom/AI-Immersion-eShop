---
id: TC-PROMO-1-02
title: promotions-api has an HTTP health check on /health
type: happy
layer: unit
covers: ["AC: AppHost resource model", "Inputs: WithHttpHealthCheck(\"/health\")"]
priority: P1
---

# TC-PROMO-1-02: promotions-api has an HTTP health check on /health

## Why

- The Aspire dashboard shows the service healthy only if the health check annotation points at `/health`; a wrong path would leave it Unhealthy forever. Unit layer per Test scope.

## Preconditions

- AppHost resource model built as in `tests/eShop.AppHost.UnitTests`.

## Steps

1. Build the model.
2. Read the health check annotations of `promotions-api`.

## Expected result

- `promotions-api` has exactly one HTTP health check annotation.
- Its path is `/health`.
