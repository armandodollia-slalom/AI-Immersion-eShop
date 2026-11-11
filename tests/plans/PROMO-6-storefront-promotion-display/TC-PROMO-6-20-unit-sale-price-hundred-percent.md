---
id: TC-PROMO-6-20
title: SalePrice with value 100 returns 0.00
type: sad
sad-path: boundary
layer: unit
covers: ["Display price rule: round(price x (1 - value/100), 2) at the upper limit of PercentOff value (PROMO-2: 0 < v <= 100)"]
priority: P3
---

# TC-PROMO-6-20: SalePrice with value 100 returns 0.00

## Why

- PROMO-2 accepts a value of 100, so the display price boundary must be exact and never negative.

## Preconditions

- No services; `PromotionPricing`.

## Steps

1. Call `SalePrice(79.99m, 100m)`.

## Expected result

- The result is `0.00` (not negative, no exception).
