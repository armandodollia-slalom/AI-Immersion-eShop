---
id: TC-BUG-6-03
title: Access token requested with the basket scope carries the basket audience
type: happy
layer: functional
covers: ["Technical Notes: ApiResources declared without scopes, so tokens carry no aud claim"]
priority: P2
---

# TC-BUG-6-03: Access token requested with the basket scope carries the basket audience

## Why

- The root cause is in Identity.API: ApiResources without scopes give tokens no `aud`. Checking the token directly pinpoints a regression in Identity.API separately from Basket.API validation, and shows the scope-less token really differs.

## Preconditions

- Test stack up with the `basket-edge` scenario loaded.

## Steps

1. Call `getTokens('alice', 'Pass123$', 'openid profile orders basket')` and decode the payload of `access_token`.
2. Call `getTokens('alice', 'Pass123$', 'openid profile orders')` and decode the payload of `access_token`.

## Expected result

- The payload from step 1 has an `aud` claim containing `basket`.
- The payload from step 2 has an `aud` claim that does not contain `basket`.
