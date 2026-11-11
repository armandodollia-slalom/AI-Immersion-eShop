---
id: TC-BUG-11-19
title: GET relevant items v2 with negative paging is 400
type: sad
sad-path: validation
layer: functional
covers: ["Implementation Notes: applied to GetRelevantItems-V2"]
priority: P2
---

# TC-BUG-11-19: GET relevant items v2 with negative paging is 400

## Why

- The Implementation Notes list `GetRelevantItems-V2` among the endpoints with the validation filter. The filter runs before the handler, so the 400 must be returned without the AI embedding service; one case per route because each route is wired separately in `MapCatalogApi`.

## Preconditions

- Test stack running (`testing/teststack up`) with the `catalog-pictures` scenario loaded; Catalog.API at `http://localhost:18082`. AI features are off in the test stack (`testing/flows/catalog.md`, Semantic search with AI disabled), so the handler would only fall back to a name prefix search.

## Steps

1. `GET http://localhost:18082/api/catalog/items/withsemanticrelevance?api-version=2.0&text=Edge&pageSize=-1` anonymously.
2. `GET http://localhost:18082/api/catalog/items/withsemanticrelevance?api-version=2.0&text=Edge&pageIndex=-1` anonymously.

## Expected result

- Both responses are `400` with `application/problem+json`.
- Each body has `status` 400 and a non-empty `errors` object; the first concerns `pageSize`, the second `pageIndex` (no message wording asserted); neither response is `500`.
