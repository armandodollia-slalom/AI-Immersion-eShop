---
id: TC-PROMO-6-21
title: A promotion matches an item only through the column its target scope names
type: sad
sad-path: boundary
layer: unit
covers: ["Inputs: Each CatalogItem (Id, CatalogTypeId, CatalogBrandId) matched against targets", "Output rule: matches the item"]
priority: P1
---

# TC-PROMO-6-21: A promotion matches an item only through the column its target scope names

## Why

- Type, Brand and Product targets all carry a numeric id, so mixing up the columns would match the wrong items; the case uses an item whose type id, brand id and own id are all different.

## Preconditions

- Item with Id 24, CatalogTypeId 4, CatalogBrandId 3. `PromotionMatching.Matches`.

## Steps

1. Call `Matches` with a promotion whose single target is `(Type, 3)`, then `(Brand, 3)`, `(Type, 4)`, `(Product, 24)`, `(Product, 3)` and `(All, null)`.

## Expected result

- `(Type, 3)` returns false; `(Brand, 3)` returns true; `(Type, 4)` returns true; `(Product, 24)` returns true; `(Product, 3)` returns false; `(All, null)` returns true.
