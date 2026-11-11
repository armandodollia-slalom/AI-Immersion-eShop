---
id: TC-BUG-12-04
title: ?page=-1 pager shows 1 / 2 with Prev disabled
type: sad
sad-path: validation
layer: e2e
covers: ["Expected: first catalog page is shown", "Code map: pager uses CurrentPage"]
priority: P2
---

# TC-BUG-12-04: ?page=-1 pager shows 1 / 2 with Prev disabled

## Why

- A negative value could yield a Prev link to a more negative page or a status like -1 / 2; asserts the clamp reaches the pager for negatives too.

## Preconditions

- Test stack running with the `catalog-edge` scenario loaded (`testing/teststack up`, `testing/teststack load catalog-edge`): 14 products named Edge 01..14, sorted by name, 9 per page, so 2 pages.
- Anonymous browser session, WebApp at `http://localhost:18080`.

## Steps

1. Open `http://localhost:18080/?page=-1`.
2. Locate the navigation named `Catalog pages`.

## Expected result

- `.page-status` has text `1 / 2`.
- The `active-page` number is `1`.
- No link with name `Previous page` exists; Prev is `span.page-nav.is-disabled`.
