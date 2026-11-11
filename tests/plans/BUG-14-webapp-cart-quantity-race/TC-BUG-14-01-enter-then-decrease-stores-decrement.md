---
id: TC-BUG-14-01
title: Enter then Decrease stores the decremented quantity
type: happy
layer: e2e
covers: ["Expected: stored quantity is 4, matching the UI", "Acceptance criterion 1"]
priority: P1
---

# TC-BUG-14-01: Enter then Decrease stores the decremented quantity

## Why

- This is the reported bug: Redis kept 5 while the UI showed 4. Because it is intermittent it is repeated 5 times. Only the browser exercises the focus/blur/change sequence, so the layer is e2e.

## Preconditions

- Test stack up with `basket-edge` loaded. bob's seeded basket (`testing/scenarios/basket-edge/scenario.yaml`, Redis key `/basket/b0b00000-0000-4000-8000-000000000002`) has two lines: Explorer 45L Backpack (ProductId 7, quantity 2) and Carbon Fiber Trekking Poles (ProductId 6, quantity 1). The case uses the first line, the backpack.

## Steps

1. Sign in as bob and open the cart.
2. In the first line's quantity box, fill `5` and press Enter; wait for the submit to finish.
3. Confirm Redis holds quantity 5 for that product in bob's basket.
4. Immediately click that line's Decrease (−) button.
5. Wait 1 second, then read bob's basket from Redis.
6. Repeat steps 1-5 five times, before each repeat run `testing/teststack load basket-edge` to restore bob's basket to the seeded state (backpack quantity 2).

## Expected result

- After step 4 the quantity box shows `4`.
- After step 5 Redis holds quantity 4 for that product, in every one of the 5 runs; it is never 5.
