---
id: TC-BUG-7-03
title: Item detail page still loads when the basket references a product missing from the catalog
type: sad
sad-path: not-found
layer: e2e
covers: ["Actual: every page fails for that user", "Expected: the site works", "Suggested fix: skip lines whose product is missing"]
priority: P1
---

# TC-BUG-7-03: Item detail page still loads when the basket references a product missing from the catalog

## Why

- The bug says the cart menu renders on every page, so a catalog lookup miss (product 99999 not found) must not break pages other than home. A separate case on a non-home page guards against a fix that only handles the home page; e2e because the layout cart menu is the failing component.

## Preconditions

- Test stack up, scenario `basket-edge` loaded; oscar's basket has product 7 and product 99999 (not in the catalog).

## Steps

1. Sign in as `oscar` / `Pass123$`.
2. Open `http://localhost:18080/item/7`.

## Expected result

- The page responds successfully (HTTP 200) and shows the "Explorer 45L Backpack" details.
- The cart menu in the header renders and no error page is shown.
- WebApp logs contain no `KeyNotFoundException` for key `99999`.
