-- Seven promotions (the stack runs with Seeding__Disabled=true, so Promotions.API seeds nothing itself).
-- Dates are relative to load time so the windows stay valid.

-- Ids 1-4: what PromotionsContextSeed inserts (active now: Published, started yesterday, ends in 90 days).
INSERT INTO "Promotions" ("Id", "Name", "Type", "Status", "StartsAt", "EndsAt", "Priority", "RequiresCoupon", "PercentOff", "AmountOff", "BuyQuantity", "GetQuantity") VALUES
  (1, '15% off everything', 'PercentOff', 'Published', now() - interval '1 day', now() + interval '90 days', 10, false, 15, NULL, NULL, NULL),
  (2, '$20 off your order', 'AmountOffOrder', 'Published', now() - interval '1 day', now() + interval '90 days', 8, false, NULL, 20, NULL, NULL),
  (3, 'Buy 2 get 1 free', 'BuyXGetY', 'Published', now() - interval '1 day', now() + interval '90 days', 6, false, NULL, NULL, 2, 1),
  (4, 'Coupon only: 10% off', 'PercentOff', 'Published', now() - interval '1 day', now() + interval '90 days', 5, true, 10, NULL, NULL, NULL);

-- Id 5: Draft, so never active even though its window is open.
-- Id 6: Published but ended yesterday.
-- Id 7: Published but starts tomorrow.
INSERT INTO "Promotions" ("Id", "Name", "Type", "Status", "StartsAt", "EndsAt", "Priority", "RequiresCoupon", "PercentOff") VALUES
  (5, 'Draft 5% off', 'PercentOff', 'Draft', now() - interval '1 day', now() + interval '30 days', 3, false, 5),
  (6, 'Ended yesterday', 'PercentOff', 'Published', now() - interval '10 days', now() - interval '1 day', 2, false, 5),
  (7, 'Starts tomorrow', 'PercentOff', 'Published', now() + interval '1 day', now() + interval '30 days', 1, false, 5);

-- Coupons of the coupon-only promotion (id 4).
INSERT INTO "Coupons" ("Id", "PromotionId", "Code") VALUES
  (1, 4, 'FALL10'),
  (2, 4, 'WELCOME5');
