-- Dates are relative to load time so the windows stay valid. Schema: PROMO-2's PromotionRuleModel migration.
-- The stack runs with Seeding__Disabled=true, so Promotions.API seeds nothing itself.

-- Ids 1-4: active now (Published, started yesterday, ends in 90 days). StartedEventSentAt is set so the lifecycle
-- worker does not write start events for them (TC-PROMO-2-67 counts the event rows of promotion 1).
INSERT INTO "Promotions" ("Id", "Name", "Description", "Type", "Value", "MinOrderTotal", "BuyQuantity", "GetQuantity", "Status", "StartsAt", "EndsAt", "Priority", "IsStackable", "RequiresCoupon", "StartedEventSentAt") VALUES
  (1, 'Fall Hiking Sale', '20% off all hiking gear', 'PercentOff', 20, NULL, NULL, NULL, 'Published', now() - interval '1 day', now() + interval '90 days', 10, false, false, now() - interval '1 day'),
  (2, 'Buy 2 Get 1 Free', 'Buy 2, get 1 free on this item', 'BuyXGetY', 0, NULL, 2, 1, 'Published', now() - interval '1 day', now() + interval '90 days', 6, false, false, now() - interval '1 day'),
  (3, '$10 off orders over $150', '$10 off your order when you spend $150 or more', 'AmountOffOrder', 10, 150, NULL, NULL, 'Published', now() - interval '1 day', now() + interval '90 days', 8, false, false, now() - interval '1 day'),
  (4, 'Coupon only: 10% off', '10% off everything with a coupon code', 'PercentOff', 10, NULL, NULL, NULL, 'Published', now() - interval '1 day', now() + interval '90 days', 5, false, true, now() - interval '1 day');

-- Id 5: Draft, so never active even though its window is open.
-- Id 6: Published but ended yesterday (start and end events recorded as sent).
-- Id 7: Published but starts tomorrow (Scheduled).
INSERT INTO "Promotions" ("Id", "Name", "Description", "Type", "Value", "Status", "StartsAt", "EndsAt", "Priority", "IsStackable", "RequiresCoupon", "StartedEventSentAt", "EndedEventSentAt") VALUES
  (5, 'Draft 5% off', '5% off everything', 'PercentOff', 5, 'Draft', now() - interval '1 day', now() + interval '30 days', 3, false, false, NULL, NULL),
  (6, 'Ended yesterday', '5% off everything', 'PercentOff', 5, 'Published', now() - interval '10 days', now() - interval '1 day', 2, false, false, now() - interval '10 days', now() - interval '1 day'),
  (7, 'Starts tomorrow', '5% off everything', 'PercentOff', 5, 'Published', now() + interval '1 day', now() + interval '30 days', 1, false, false, NULL, NULL);

INSERT INTO "PromotionTargets" ("Id", "PromotionId", "Scope", "TargetId") VALUES
  (1, 1, 'Type', 3),
  (2, 2, 'Product', 40),
  (3, 3, 'All', NULL),
  (4, 4, 'All', NULL),
  (5, 5, 'All', NULL),
  (6, 6, 'All', NULL),
  (7, 7, 'All', NULL);

-- Coupons of the coupon-only promotion (id 4).
INSERT INTO "Coupons" ("Id", "PromotionId", "Code") VALUES
  (1, 4, 'FALL10'),
  (2, 4, 'WELCOME5');

-- Explicit ids above: move the identity sequences past them so promotions created through the API get new ids.
SELECT setval(pg_get_serial_sequence('"Promotions"', 'Id'), 7);
SELECT setval(pg_get_serial_sequence('"PromotionTargets"', 'Id'), 7);
SELECT setval(pg_get_serial_sequence('"Coupons"', 'Id'), 2);
