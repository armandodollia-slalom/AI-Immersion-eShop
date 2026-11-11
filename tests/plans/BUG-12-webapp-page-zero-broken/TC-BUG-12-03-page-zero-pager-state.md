---
id: TC-BUG-12-03
title: ?page=0 pager shows 1 / 2 with Prev disabled
type: sad
sad-path: validation
layer: e2e
covers: ["Expected: first catalog page is shown", "Code map: pager uses CurrentPage"]
priority: P2
---

# TC-BUG-12-03: ?page=0 pager shows 1 / 2 with Prev disabled

## Why

- The pager derives Prev, Next and the status from the page number; a raw 0 would show 0 / 2 and a Prev link to page -1. Separate from the list contents (TC-01).

## Preconditions

- Test stack running with the `catalog-edge` scenario loaded (`testing/teststack up`, `testing/teststack load catalog-edge`): 14 products named Edge 01..14, sorted by name, 9 per page, so 2 pages.
- Anonymous browser session, WebApp at `http://localhost:18080`.

## Steps

1. Open `http://localhost:18080/?page=0`.
2. Locate the navigation named `Catalog pages`.

## Expected result

- `.page-status` has text `1 / 2`.
- `.page-number` elements read `1` and `2`; the one with class `active-page` is `1`.
- The Prev control is a `span.page-nav.is-disabled` (no link with name `Previous page` exists).
- The Next control is a link with name `Next page`.
