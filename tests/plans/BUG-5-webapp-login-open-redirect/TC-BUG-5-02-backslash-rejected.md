---
id: TC-BUG-5-02
title: returnUrl /\evil.example redirects to the home page
type: sad
sad-path: validation
layer: e2e
covers: ["Suggested fix: not followed by backslash"]
priority: P1
---

# TC-BUG-5-02: returnUrl /\evil.example redirects to the home page

## Why

- Browsers treat `/\` like `//`, so the fix rule excludes a backslash after the leading slash. Separate case because a fix checking only `//` would miss it.

## Preconditions

- Test stack up with the `auth-lockout` scenario loaded; WebApp at http://localhost:18080.
- Browser context signed in as alice (`Pass123$`).

## Steps

1. With the signed-in alice context, send `GET http://localhost:18080/user/login?returnUrl=%2F%5Cevil.example` without following redirects.

## Expected result

- Status is 302.
- `Location` is `http://localhost:18080/`; host is never `evil.example`.
