---
id: TC-BUG-5-04
title: Base-relative returnUrl item/7 is honoured
type: happy
layer: e2e
covers: ["Suggested fix: accept local paths", "Decisions: base-relative paths stay allowed"]
priority: P1
---

# TC-BUG-5-04: Base-relative returnUrl item/7 is honoured

## Why

- The fix must not break legitimate return URLs; `LogIn.Url(nav)` produces base-relative paths like `item/7`.

## Preconditions

- Test stack up with the `auth-lockout` scenario loaded; WebApp at http://localhost:18080.
- Browser context signed in as alice (`Pass123$`).

## Steps

1. In the signed-in alice context, navigate to `http://localhost:18080/user/login?returnUrl=item%2F7`.

## Expected result

- The browser ends at `http://localhost:18080/item/7`.
