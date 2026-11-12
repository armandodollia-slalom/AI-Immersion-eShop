---
id: TC-BUG-9-02
title: A rejected order creates no order
type: sad
sad-path: validation
layer: functional
covers: ["Expected: no order is created"]
priority: P0
---

# TC-BUG-9-02: A rejected order creates no order

## Why

- The bug report states no order is created; this pins that the 400 path leaves persistence untouched, as a separate observable from the status code.

## Preconditions

- Scenario `ordering-two-buyers` loaded (alice owns orders 1-6, bob owns 7 and 8).
- alice has exactly 6 orders (numbers 1-6).

## Steps

1. `GET /api/orders?api-version=1.0` as alice and note the list.
2. Send the empty-items request from TC-BUG-9-01 as alice.
3. `GET /api/orders?api-version=1.0` as alice again.

## Expected result

- Step 2 returns 400.
- Step 3 returns exactly the same 6 orders (numbers 1-6) as step 1.
- `GET /api/orders?api-version=1.0` as bob still returns 2 orders (7 and 8).
