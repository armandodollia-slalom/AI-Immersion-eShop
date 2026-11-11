---
id: TC-PROMO-6-24
title: PromotionsService drops coupon-only promotions from the /active response
type: sad
sad-path: validation
layer: unit
covers: ["AC: promotion with requiresCoupon = true is never shown (PromotionsService read)"]
priority: P2
---

# TC-PROMO-6-24: PromotionsService drops coupon-only promotions from the /active response

## Why

- The service is the first of three filters; a fake `HttpMessageHandler` and an in-memory cache make this runnable without services.

## Preconditions

- `PromotionsService` built with a fake handler returning JSON for promotions 1 (requiresCoupon false) and 4 (requiresCoupon true), a real `MemoryCache` and a null logger.

## Steps

1. Call `GetActivePromotionsAsync()`.

## Expected result

- The result contains exactly one promotion, id 1.
