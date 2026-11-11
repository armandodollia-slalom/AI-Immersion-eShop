---
id: TC-PROMO-1-21
title: Signing in to the WebApp yields a token with the promotions scope that is accepted
type: happy
layer: e2e
covers: ["AC: user signs in to the WebApp", "Outputs: WebApp requests the promotions scope at sign-in"]
priority: P1
---

# TC-PROMO-1-21: Signing in to the WebApp yields a token with the promotions scope that is accepted

## Why

- Only the real WebApp sign-in proves the WebApp requests the scope and the webapp client is allowed it; no cheaper layer exercises both sides. Test stack scenario must load promotions data because the stack runs with `Seeding__Disabled=true`.

## Preconditions

- Test stack running with the default scenario plus a promotions scenario loading the 4 seeded promotions and the Draft, ended-yesterday and starts-tomorrow promotions into `promotionsdb` (7 rows).
- User alice (password `Pass123$`).

## Steps

1. Open the WebApp and sign in as alice through the Identity login page.
2. Read the access token the WebApp holds for the session.
3. Decode the token and read its `scope` claim.
4. `GET /api/promotions?api-version=1.0` against Promotions.API with that token.

## Expected result

- Sign-in completes and the WebApp shows alice as signed in.
- The `scope` claim includes `promotions`.
- The call returns `200` with 7 promotions.
