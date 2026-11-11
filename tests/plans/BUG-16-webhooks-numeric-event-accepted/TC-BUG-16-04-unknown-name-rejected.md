---
id: TC-BUG-16-04
title: Non-numeric unknown event name is rejected
type: sad
sad-path: validation
layer: functional
covers: ["Spec test: event names outside WebhookType are rejected"]
priority: P2
---

# TC-BUG-16-04: Non-numeric unknown event name is rejected

## Why

- Confirms the pre-existing rejection of unknown names survives the change to the validation expression.

## Preconditions

- Test stack up, `webhooks-subscriptions` scenario loaded; alice has a valid token.

## Steps

1. As alice, `POST http://localhost:18085/api/webhooks?api-version=1.0` with body `{"url":"http://webhooksclient:8080/webhook-received","token":"unknown-name","event":"NotAnEvent","grantUrl":"http://webhooksclient:8080/check"}`.

## Expected result

- Status 400 and the body contains "NotAnEvent is invalid event name".
- No subscription with token "unknown-name" appears in alice's `GET /api/webhooks`.
