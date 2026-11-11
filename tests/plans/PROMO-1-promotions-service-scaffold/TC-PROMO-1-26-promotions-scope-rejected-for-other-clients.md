---
id: TC-PROMO-1-26
title: Other clients cannot request the promotions scope
type: sad
sad-path: validation
layer: functional
covers: ["Outputs: promotions is in the webapp client's allowed scopes only"]
priority: P2
---

# TC-PROMO-1-26: Other clients cannot request the promotions scope

## Why

- The story decided the scope goes to `webapp` only; this catches it being added to another client.

## Preconditions

- Identity.API running; client `webhooksclient` (code flow) with its registered redirect URI.

## Steps

1. `GET /connect/authorize` with `client_id=webhooksclient`, `response_type=code`, its registered `redirect_uri`, `scope=openid promotions`.

## Expected result

- The authorization request is rejected with error `invalid_scope`.
- No login page is shown for a code.
