---
id: TC-BUG-11-13
title: GET items by name with negative paging is 400
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: applied to GetItemsByName", "Technical Notes: pass values straight to Skip/Take"]
priority: P2
---

# TC-BUG-11-13: GET items by name with negative paging is 400

## Why

- `GetItemsByName` binds `PaginationRequest` separately and had the same defect; one request with both values negative keeps the case to one behavior (the filter is applied).

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded (`testing/teststack load catalog-pictures`); Catalog.API at `http://localhost:18082`, mobile BFF at `http://localhost:18087`.
- Catalog contains at least 11 items, so a default page (`pageSize=10`) is full.

## Steps

1. `GET http://localhost:18082/api/catalog/items/by/Edge?api-version=1.0&pageSize=-1` anonymously.
2. `GET http://localhost:18082/api/catalog/items/by/Edge?api-version=1.0&pageIndex=-1` anonymously.

## Expected result

- Both responses are `400` with `application/problem+json`.
- Each body has `status` 400 and a non-empty `errors` object; the first concerns `pageSize`, the second `pageIndex` (no message wording asserted); neither response is `500`.
