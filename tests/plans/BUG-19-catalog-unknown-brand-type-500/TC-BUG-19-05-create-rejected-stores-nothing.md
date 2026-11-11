---
id: TC-BUG-19-05
title: Rejected create with unknown ids stores no item
type: sad
sad-path: validation
layer: functional
covers: ["Expected: 400 before saving", "Technical Notes: check before saving"]
priority: P1
---

# TC-BUG-19-05: Rejected create with unknown ids stores no item

## Why

- A 400 must mean nothing was persisted; protects against validating after a partial save.

## Preconditions

- Test stack up, scenario `catalog-edge` loaded (14 items).
- Admin bearer token.

## Steps

1. `GET http://localhost:18082/api/catalog/items?api-version=2.0&pageSize=50` and note `count`.
2. `POST http://localhost:18082/api/catalog/items?api-version=2.0` as admin with body `{"name":"Edge 15 New Lantern","description":"Edge","price":42.5,"pictureFileName":"7.webp","catalogTypeId":999,"catalogBrandId":2,"availableStock":12,"restockThreshold":2,"maxStockThreshold":50}`.
3. Repeat step 1.

## Expected result

- Step 1 `count` is 14.
- Step 2 returns 400.
- Step 3 `count` is still 14 and no item named "Edge 15 New Lantern" is listed.
