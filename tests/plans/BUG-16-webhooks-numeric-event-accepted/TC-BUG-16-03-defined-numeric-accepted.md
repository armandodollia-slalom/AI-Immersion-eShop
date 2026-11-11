---
id: TC-BUG-16-03
title: Numeric string mapping to a defined member ("1") is still accepted
type: happy
layer: functional
covers: ["Implementation Notes: Decisions (TryParse and IsDefined)"]
priority: P2
---

# TC-BUG-16-03: Numeric string mapping to a defined member ("1") is still accepted

## Why

- The documented decision is that only undefined values are rejected; this boundary case (just inside the allowed range, value 1 = CatalogItemPriceChange) guards against over-tightening to "reject all numerics".

## Preconditions

- Test stack up, `webhooks-subscriptions` scenario loaded; alice has a valid token.

## Steps

1. As alice, `POST http://localhost:18085/api/webhooks?api-version=1.0` with body `{"url":"http://webhooksclient:8080/webhook-received","token":"numeric-defined","event":"1","grantUrl":"http://webhooksclient:8080/check"}`.

## Expected result

- Status 201 with a `Location` header matching `/api/webhooks/<id>`.
- `GET /api/webhooks` as alice lists a subscription with token "numeric-defined" and type CatalogItemPriceChange.
