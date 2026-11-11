---
id: TC-BUG-7-01
title: Home page loads for oscar despite a missing-product basket line
type: happy
layer: e2e
covers: ["Expected: The site works", "Actual: every page fails, cart menu renders on every page"]
priority: P1
---

# TC-BUG-7-01: Home page loads for oscar despite a missing-product basket line

## Why

- The bug made every page fail because the cart menu renders everywhere and threw KeyNotFoundException. The catalog home page is the simplest page that proves the cart menu no longer throws; e2e is needed because the failure shows in the rendered page.

## Preconditions

- Test stack up, scenario `basket-edge` loaded. Oscar's Redis basket has product 7 and product 99999 (not in catalog).

## Steps

1. Sign in at `http://localhost:18080/` as `oscar` / `Pass123$`.
2. Open `http://localhost:18080/`.

## Expected result

- The catalog page renders with product cards visible; no error page is shown.
- The cart menu in the header renders.
- WebApp logs contain no `KeyNotFoundException` for key `99999`.
