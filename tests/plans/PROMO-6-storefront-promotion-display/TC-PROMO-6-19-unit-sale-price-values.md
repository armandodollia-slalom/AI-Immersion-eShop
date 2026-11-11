---
id: TC-PROMO-6-19
title: SalePrice returns round(price x (1 - value/100), 2) for percent offers
type: happy
layer: unit
covers: ["Display price rule: round(price x (1 - value/100), 2)", "Rule: must match PROMO-3 for a quantity-1 line"]
priority: P1
---

# TC-PROMO-6-19: SalePrice returns round(price x (1 - value/100), 2) for percent offers

## Why

- The display rule is pure arithmetic in `PromotionPricing.SalePrice`; a unit case checks the exact values the e2e tiles rely on, including a value with a third decimal that must be rounded.

## Preconditions

- No services; `eShop.WebAppComponents.Promotions.PromotionPricing`.

## Steps

1. Call `SalePrice(79.99m, 20m)`, `SalePrice(299.99m, 20m)`, `SalePrice(21.99m, 20m)`, `SalePrice(399.00m, 20m)` and `SalePrice(109.99m, 5m)`.

## Expected result

- Results are `63.99`, `239.99`, `17.59`, `319.20` and `104.49`.
- None has more than 2 decimals.
