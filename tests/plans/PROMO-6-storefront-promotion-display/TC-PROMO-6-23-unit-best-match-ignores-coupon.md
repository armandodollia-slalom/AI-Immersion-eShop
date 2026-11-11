---
id: TC-PROMO-6-23
title: BestMatch ignores a coupon-only promotion even when it has the highest priority
type: sad
sad-path: validation
layer: unit
covers: ["AC: promotion with requiresCoupon = true is never shown (BestMatch)"]
priority: P1
---

# TC-PROMO-6-23: BestMatch ignores a coupon-only promotion even when it has the highest priority

## Why

- Defense in depth: the story forbids showing coupon-only promotions even if `/active` ever returned one, and this check lives in the shared WebAppComponents code.

## Preconditions

- Item 3. Promotions: id 1 priority 10 `PercentOff` on Type 3 (requiresCoupon false); id 4 priority 100 `PercentOff` on All with `RequiresCoupon = true`.

## Steps

1. Call `BestMatch` with both promotions.

## Expected result

- The result is promotion id 1.
- With only promotion 4 in the list the result is null.
