---
id: TC-BUG-5-01
title: Protocol-relative returnUrl //evil.example redirects to the home page
type: sad
sad-path: validation
layer: e2e
covers: ["Expected: / when the return URL is not local", "Suggested fix: single leading / not followed by /"]
priority: P1
---

# TC-BUG-5-01: Protocol-relative returnUrl //evil.example redirects to the home page

## Why

- This is the reported bug: `//evil.example` is treated as relative and yields an off-site 302 usable for phishing. Run at e2e because the redirect is produced by the WebApp page and observed as a Location header.

## Preconditions

- Test stack up with the `auth-lockout` scenario loaded; WebApp at http://localhost:18080.
- Browser context signed in as alice (`Pass123$`).

## Steps

1. With the signed-in alice context, send `GET http://localhost:18080/user/login?returnUrl=%2F%2Fevil.example` without following redirects.

## Expected result

- Status is 302.
- `Location` is `http://localhost:18080/`; its host is `localhost:18080`, never `evil.example`.
