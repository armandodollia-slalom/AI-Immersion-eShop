---
story: PROMO-2
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/53"
story-sha: ba78b5e9babf
plan-sha: 9942530c1dec
verified-score: 9
verified-at: "2026-11-11T18:38:44.435Z"
verified-by: qe-plan@c3934e11/73ba1657
---
# Test plan: PROMO-2 [BE - Promotions.API] - Promotion rule model and admin API

This plan covers the admin API (create, get, list, update, publish, end), the anonymous `GET /api/promotions/active` feed, field validation, the Draft/Published/Ended lifecycle with computed `EffectiveStatus`, the start and end integration events sent through the outbox by the lifecycle worker, and admin authorization. Everything runs at the functional layer against real Postgres with the `promo-1` scenario (promotions 1-7) and the worker running; events are checked in the `IntegrationEventLog` table of `promotionsdb`. The story has no UI, so there are no e2e cases, and it has no unit-testable component outside the functional host. All requests pass `?api-version=1.0`. Every case starts from a freshly reloaded `promo-1` scenario (database reset before the case), so cases are order-independent and may assume the seed of exactly 7 promotions unless they create their own.

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-PROMO-2-01 | Valid promotion is created as Draft with 201, Location and the full body | happy | functional | Outputs: POST 201 + Location + full promotion; AC: valid promotion saved as Draft |
| TC-PROMO-2-02 | Omitted priority, isStackable and requiresCoupon default to 0, false, false | happy | functional | Inputs: Priority default 0; Inputs: IsStackable default false; Inputs: RequiresCoupon default false |
| TC-PROMO-2-03 | A status sent in the create body is ignored and the promotion is saved as Draft | happy | functional | Endpoints: Create (always as Draft) |
| TC-PROMO-2-04 | A target with scope All and null targetId is accepted | happy | functional | Inputs: Targets TargetId null only when Scope = All |
| TC-PROMO-2-05 | Several targets of different scopes are all stored and returned | happy | functional | Inputs: Targets at least 1; Scope All, Brand, Type or Product |
| TC-PROMO-2-06 | PercentOff value 100 is accepted | happy | functional | Inputs: PercentOff 0 < v <= 100 (upper boundary inside) |
| TC-PROMO-2-07 | Valid BuyXGetY ignores value and keeps both quantities | happy | functional | Inputs: Value ignored for BuyXGetY; Inputs: BuyQuantity/GetQuantity both >= 1 for BuyXGetY |
| TC-PROMO-2-08 | Valid AmountOffOrder with minOrderTotal is accepted | happy | functional | Inputs: AmountOffOrder v > 0; MinOrderTotal required for AmountOffOrder |
| TC-PROMO-2-09 | Name of exactly 100 characters is accepted | happy | functional | Inputs: Name max 100 (inside boundary) |
| TC-PROMO-2-10 | Description of exactly 500 characters is accepted | happy | functional | Inputs: Description max 500 (inside boundary) |
| TC-PROMO-2-11 | endsAt equal to startsAt is rejected | sad | functional | AC: endsAt <= startsAt; Inputs: EndsAt > StartsAt |
| TC-PROMO-2-12 | endsAt before startsAt is rejected | sad | functional | AC: endsAt <= startsAt; Outputs: 400 field-level errors |
| TC-PROMO-2-13 | PercentOff value 0 is rejected | sad | functional | AC: PercentOff value outside (0, 100]; Inputs: PercentOff 0 < v |
| TC-PROMO-2-14 | PercentOff value 100.01 is rejected | sad | functional | AC: PercentOff value outside (0, 100]; Inputs: PercentOff v <= 100 |
| TC-PROMO-2-15 | PercentOff negative value is rejected | sad | functional | AC: PercentOff value outside (0, 100] |
| TC-PROMO-2-16 | AmountOffOrder without minOrderTotal is rejected | sad | functional | AC: AmountOffOrder has no minOrderTotal; Inputs: MinOrderTotal required for AmountOffOrder |
| TC-PROMO-2-17 | AmountOffOrder value 0 is rejected | sad | functional | Inputs: AmountOffOrder v > 0 |
| TC-PROMO-2-18 | BuyXGetY without getQuantity is rejected | sad | functional | AC: BuyXGetY is missing a quantity; Inputs: BuyQuantity/GetQuantity both required |
| TC-PROMO-2-19 | BuyXGetY without buyQuantity is rejected | sad | functional | AC: BuyXGetY is missing a quantity |
| TC-PROMO-2-20 | BuyXGetY with buyQuantity 0 is rejected | sad | functional | Inputs: BuyQuantity/GetQuantity >= 1 |
| TC-PROMO-2-21 | Empty targets array is rejected | sad | functional | AC: targets is empty; Inputs: Targets at least 1 |
| TC-PROMO-2-22 | Brand target without targetId is rejected | sad | functional | Inputs: TargetId null only when Scope = All |
| TC-PROMO-2-23 | All target with a targetId is rejected | sad | functional | Inputs: TargetId null only when Scope = All |
| TC-PROMO-2-24 | Missing name is rejected | sad | functional | Inputs: Name required |
| TC-PROMO-2-25 | Name of 101 characters is rejected | sad | functional | Inputs: Name max 100 |
| TC-PROMO-2-26 | Missing description is rejected | sad | functional | Inputs: Description required |
| TC-PROMO-2-27 | Description of 501 characters is rejected | sad | functional | Inputs: Description max 500 |
| TC-PROMO-2-28 | Several invalid fields are all reported in one 400 and nothing is saved | sad | functional | AC: 400 with an error naming each failing field; Outputs: 400 ValidationProblem with field-level errors |
| TC-PROMO-2-29 | Admin gets one promotion with status and effectiveStatus | happy | functional | Endpoints: GET /api/promotions/{id}; Inputs: EffectiveStatus computed |
| TC-PROMO-2-30 | GET of an unknown id returns 404 | sad | functional | Errors: 404 if the promotion is unknown |
| TC-PROMO-2-31 | List filtered by status=Active returns only Active promotions | happy | functional | Endpoints: list filtered by EffectiveStatus (Active) |
| TC-PROMO-2-32 | List filtered by status=Scheduled returns only Scheduled promotions | happy | functional | Endpoints: list filtered by EffectiveStatus (Scheduled) |
| TC-PROMO-2-33 | List filtered by status=Expired returns only Expired promotions | happy | functional | Endpoints: list filtered by EffectiveStatus (Expired) |
| TC-PROMO-2-34 | List filtered by status=Draft returns only Draft promotions | happy | functional | Endpoints: list filtered by EffectiveStatus (Draft) |
| TC-PROMO-2-35 | Paging splits the promotions into pages of the requested size | happy | functional | Endpoints: list paged (page, pageSize) |
| TC-PROMO-2-36 | A page past the last one returns an empty list | sad | functional | Endpoints: list paged |
| TC-PROMO-2-37 | Unknown status filter returns 400 | sad | functional | Endpoints: status filter takes an EffectiveStatus value |
| TC-PROMO-2-38 | pageSize 0 returns 400 | sad | functional | Endpoints: paged list |
| TC-PROMO-2-39 | pageSize 101 returns 400 | sad | functional | Endpoints: paged list |
| TC-PROMO-2-40 | Negative page returns 400 | sad | functional | Endpoints: paged list |
| TC-PROMO-2-41 | PUT on a Draft promotion updates it and returns 200 | happy | functional | Endpoints: PUT while Draft; Outputs: PUT 200 with full promotion |
| TC-PROMO-2-42 | PUT on a Scheduled promotion updates it and returns 200 | happy | functional | Endpoints: PUT while Scheduled |
| TC-PROMO-2-43 | PUT on an Active promotion returns 409 and changes nothing | sad | functional | AC: editing an Active promotion returns 409; Errors: 409 when editing Active |
| TC-PROMO-2-44 | PUT on an Expired promotion returns 409 | sad | functional | Errors: 409 when editing an Expired promotion |
| TC-PROMO-2-45 | PUT on a promotion ended through /end returns 409 | sad | functional | Errors: 409 when editing an Expired promotion; Endpoints: end |
| TC-PROMO-2-46 | PUT on an unknown id returns 404 | sad | functional | Errors: 404 if the promotion is unknown |
| TC-PROMO-2-47 | PUT with an invalid body on a Draft returns 400 and changes nothing | sad | functional | Outputs: 400 for every rule in the table (also on update) |
| TC-PROMO-2-48 | Publishing a Draft that has already started makes it Active and sends the start event once | happy | functional | AC: publish with startsAt in the past -> Active and PromotionStartedIntegrationEvent once; Endpoints: publish |
| TC-PROMO-2-49 | Publishing a Draft with a future start makes it Scheduled and sends no event yet | happy | functional | AC: publish with startsAt in the future -> Scheduled |
| TC-PROMO-2-50 | Publish of an unknown id returns 404 | sad | functional | Errors: 404 if the promotion is unknown |
| TC-PROMO-2-51 | A scheduled start event is published within 60s of startsAt | happy | functional | AC: Scheduled -> event published within 60s of startsAt; Outputs: PromotionStartedIntegrationEvent sent when StartsAt passes |
| TC-PROMO-2-53 | The start event carries id, name, description, badge label, end and targets | happy | functional | Outputs: PromotionStartedIntegrationEvent { PromotionId, Name, Description, BadgeLabel, EndsAt, Targets[] } |
| TC-PROMO-2-54 | Outbox entries reach the Published state after sending | happy | functional | Outputs: events published through the outbox (IntegrationEventLogEF) |
| TC-PROMO-2-55 | End on an Active promotion returns 204, expires it, sends the end event once and removes it from /active | happy | functional | AC: /end -> Expired, PromotionEndedIntegrationEvent once, drops out of /active; Outputs: end 204 |
| TC-PROMO-2-56 | An Active promotion that reaches endsAt expires and sends the end event within 60s | happy | functional | AC: Active promotion reaches endsAt -> Expired, event once, out of /active; Outputs: PromotionEndedIntegrationEvent sent when EndsAt passes |
| TC-PROMO-2-57 | End of an unknown id returns 404 | sad | functional | Errors: 404 if the promotion is unknown |
| TC-PROMO-2-58 | Anonymous /active returns only active, non-coupon promotions | happy | functional | AC: anonymous caller gets only active promotions that don't need a coupon; Outputs: coupon-only promotions left out |
| TC-PROMO-2-59 | Each /active element has the public shape | happy | functional | Outputs: GET /active public shape |
| TC-PROMO-2-60 | A published coupon-only promotion created through the API is not in /active | sad | functional | Outputs: coupon-only promotions left out of the public feed |
| TC-PROMO-2-61 | A Draft created through the API is not in /active | sad | functional | AC: only active promotions are in /active |
| TC-PROMO-2-62 | Every admin endpoint returns 401 without a token | sad | functional | AC: anonymous caller on any admin endpoint -> 401 |
| TC-PROMO-2-63 | A malformed bearer token returns 401 | sad | functional | Outputs: 401 when the caller isn't an admin |
| TC-PROMO-2-64 | A token without the admin role is forbidden on every admin endpoint | sad | functional | Errors: 401 or 403 when the caller isn't an admin |
| TC-PROMO-2-65 | A token with the admin role but without the promotions scope is rejected | sad | functional | Errors: 401 or 403 when the caller isn't an admin |
| TC-PROMO-2-66 | /active stays anonymous even with an invalid token | happy | functional | Endpoints: GET /active anonymous |
| TC-PROMO-2-67 | Publish of a non-Draft promotion returns 409 and changes nothing | sad | functional | Implementation Notes: /publish on a non-Draft returns 409; Endpoints: publish changes Draft to Published |

## Out of scope

- Multi-tenancy section (tenant isolation, `tenantId` in the body): the implementation notes record that the codebase has no tenant concept yet, so the story's tenancy criteria are not testable.
- The migration's data folding of PROMO-1 rows and the DB check constraint on `TargetId`: implementation detail, not a story requirement.
- Rejection of an unknown `type` or `scope` enum string: the story does not say how it is reported.

## Open questions

- Publishing a Draft whose window has already ended: the story does not say whether it is allowed or what happens to events. No case written.
- `POST /{id}/end` on a Draft, a Scheduled or an already ended promotion: the story defines `end` for Active promotions only (implementation notes: no end event, repeated end returns 204). No case written.
- Order of checks on `PUT` (404, 409, then 400) when a request is both invalid and on a non-editable promotion: undefined in the story.
- Whether a `PUT` that moves a published start into the past sends its start event: undefined in the story.
- Concurrent worker and admin calls (the story does not specify behavior); the implementation uses an `xmin` concurrency token with `409`.
- `badgeLabel` format beyond the story's examples (`-20%`, `Buy 2 Get 1`): the story leaves open whether it is computed; the `$10 off` form for AmountOffOrder is not asserted.
- Whether `/active` may contain properties beyond the story's sample (the implementation adds `startsAt`): the shape case asserts only that the listed fields are present.
- Ordering and the paged-response envelope (`page`, `pageSize`, `total`) are not asserted; `/active` ordering is not asserted either. `pageSize` limits (1-100), `page >= 0` and the error for an unknown `status` filter come from the implementation notes; the story only says "paged, filtered by `EffectiveStatus`". The related cases are marked P2 or follow the filter wording and may need revision if the story differs.
- Which of `401` or `403` a non-admin receives: the story allows either; cases assume `401` without a token and `403` for an authenticated non-admin, as in the implementation notes.
