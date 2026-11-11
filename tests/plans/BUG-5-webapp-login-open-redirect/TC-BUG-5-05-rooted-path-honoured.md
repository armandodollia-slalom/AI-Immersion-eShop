---
id: TC-BUG-5-05
title: Single-leading-slash returnUrl /item/7 is honoured
type: happy
layer: e2e
covers: ["Suggested fix: a single leading /"]
priority: P1
---

# TC-BUG-5-05: Single-leading-slash returnUrl /item/7 is honoured

## Why

- The positive side of the rule: one leading slash not followed by `/` or `\` is local and must be kept. Separate from TC-BUG-5-04 because it is the exact accepted form named in the story.

## Preconditions

- Test stack up with the `auth-lockout` scenario loaded; WebApp at http://localhost:18080.
- Browser context signed in as alice (`Pass123$`).

## Steps

1. With the signed-in alice context, send `GET http://localhost:18080/user/login?returnUrl=%2Fitem%2F7` without following redirects.

## Expected result

- Status is 302.
- `Location` is `http://localhost:18080/item/7`.
