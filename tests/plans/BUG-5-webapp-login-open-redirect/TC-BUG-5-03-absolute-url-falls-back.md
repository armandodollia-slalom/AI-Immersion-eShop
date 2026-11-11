---
id: TC-BUG-5-03
title: Absolute returnUrl falls back to the home page
type: sad
sad-path: validation
layer: e2e
covers: ["Expected: / when the return URL is not local"]
priority: P2
---

# TC-BUG-5-03: Absolute returnUrl falls back to the home page

## Why

- Guards the already-correct absolute-URL handling against regression while the local-path rule is rewritten.

## Preconditions

- Test stack up with the `auth-lockout` scenario loaded; WebApp at http://localhost:18080.
- Browser context signed in as alice (`Pass123$`).

## Steps

1. With the signed-in alice context, send `GET http://localhost:18080/user/login?returnUrl=https%3A%2F%2Fevil.example%2F` without following redirects.

## Expected result

- Status is 302.
- `Location` is `http://localhost:18080/`.
