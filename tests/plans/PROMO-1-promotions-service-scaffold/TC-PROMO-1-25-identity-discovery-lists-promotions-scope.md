---
id: TC-PROMO-1-25
title: Identity discovery document lists the promotions scope
type: happy
layer: functional
covers: ["Outputs: Identity has an API resource and an API scope named promotions"]
priority: P1
---

# TC-PROMO-1-25: Identity discovery document lists the promotions scope

## Why

- Cheapest observable proof that the `ApiScope` and `ApiResource` are registered in Identity.API.

## Preconditions

- Identity.API running (test stack or functional host).

## Steps

1. `GET /.well-known/openid-configuration` anonymously.

## Expected result

- Status `200`.
- `scopes_supported` contains `promotions`.
