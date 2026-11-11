---
id: TC-BUG-16-02
title: Valid event name OrderShipped is still accepted
type: happy
layer: functional
covers: ["Regression: valid WebhookType names"]
priority: P1
---

# TC-BUG-16-02: Valid event name OrderShipped is still accepted

## Why

- The fix tightens validation; a regression that rejects valid names would break all subscriptions. Functional layer against the real API.

## Preconditions

- Test stack up, `webhooks-subscriptions` scenario loaded; alice has a valid token.

## Steps

1. As alice, `POST http://localhost:18085/api/webhooks?api-version=1.0` with body `{"url":"http://webhooksclient:8080/webhook-received","token":"valid-name","event":"OrderShipped","grantUrl":"http://webhooksclient:8080/check"}`.

## Expected result

- Status 201 with a `Location` header matching `/api/webhooks/<id>`.
- `GET /api/webhooks` as alice lists a subscription with token "valid-name" and type OrderShipped.
