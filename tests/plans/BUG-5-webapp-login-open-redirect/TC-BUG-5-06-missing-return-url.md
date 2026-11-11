---
id: TC-BUG-5-06
title: No returnUrl redirects to the home page
type: happy
layer: e2e
covers: ["Expected: / when the return URL is not local"]
priority: P2
---

# TC-BUG-5-06: No returnUrl redirects to the home page

## Why

- Missing input must still land on `/` after the validation helper is introduced.

## Preconditions

- Test stack up with the `auth-lockout` scenario loaded; WebApp at http://localhost:18080.
- Browser context signed in as alice (`Pass123$`).

## Steps

1. With the signed-in alice context, send `GET http://localhost:18080/user/login` without following redirects.

## Expected result

- Status is 302.
- `Location` is `http://localhost:18080/`.
