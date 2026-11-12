---
id: TC-BUG-16-01
title: Numeric event "99" is rejected with 400 and not stored
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 BadRequest '99 is invalid event name'", "Steps to Reproduce 1"]
priority: P1
---

# TC-BUG-16-01: Numeric event "99" is rejected with 400 and not stored

## Why

- This is the reported bug: `Enum.TryParse` accepted any number, storing a subscription that never fires. Functional layer is the cheapest that hits the real API and database.

## Preconditions

- Test stack up, `webhooks-subscriptions` scenario loaded. alice has a valid token; she owns subscriptions 1 and 2.

## Steps

1. As alice, `GET http://localhost:18085/api/webhooks?api-version=1.0`; note the count.
2. As alice, `POST http://localhost:18085/api/webhooks?api-version=1.0` with body `{"url":"http://webhooksclient:8080/webhook-received","token":"numeric","event":"99","grantUrl":"http://webhooksclient:8080/check"}`.
3. As alice, `GET /api/webhooks` again.

## Expected result

- Step 2 returns 400 and the body contains "99 is invalid event name".
- No `Location` header is returned.
- Step 3 returns the same number of subscriptions as step 1; none has token "numeric".
