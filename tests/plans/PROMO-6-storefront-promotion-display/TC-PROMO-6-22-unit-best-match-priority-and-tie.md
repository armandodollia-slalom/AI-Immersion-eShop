---
id: TC-PROMO-6-22
title: BestMatch picks the highest priority and breaks ties by the lowest id
type: happy
layer: unit
covers: ["Output rule: highest-priority matching promotion", "Decision: ties go to the lowest id, same order as /active"]
priority: P1
---

# TC-PROMO-6-22: BestMatch picks the highest priority and breaks ties by the lowest id

## Why

- Both the catalog tile and the item page depend on this single ordering; equal priorities cannot be produced reliably through the API stack, so it is a unit case.

## Preconditions

- Item 3 (type 3). Promotions: id 1 priority 10, id 2 priority 20, id 3 priority 20, all `PercentOff` targeting All.

## Steps

1. Call `BestMatch` with the three promotions in the order 3, 1, 2.

## Expected result

- The result is promotion id 2 (priority 20, lowest id among the tied).
