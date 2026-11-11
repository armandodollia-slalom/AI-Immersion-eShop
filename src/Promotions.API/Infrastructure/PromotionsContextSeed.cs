namespace Promotions.API.Infrastructure;

/// <summary>
/// The epic's demo data, all Published and active now (started yesterday, ends in 90 days): a 20% sale on catalog
/// type 3, Buy 2 Get 1 on product 40, $10 off orders of $150 or more, and a coupon-only 10% off (FALL10, WELCOME5).
/// </summary>
public class PromotionsContextSeed(TimeProvider timeProvider) : IDbSeeder<PromotionsContext>
{
    public async Task SeedAsync(PromotionsContext context)
    {
        if (await context.Promotions.AnyAsync())
        {
            return;
        }

        var now = timeProvider.GetUtcNow();
        var startsAt = now.AddDays(-1);
        var endsAt = now.AddDays(90);

        context.Promotions.AddRange(
            new Promotion
            {
                Name = "Fall Hiking Sale",
                Description = "20% off all hiking gear",
                Type = PromotionType.PercentOff,
                Value = 20m,
                Targets = [new PromotionTarget { Scope = PromotionScope.Type, TargetId = 3 }],
                Status = PromotionStatus.Published,
                StartsAt = startsAt,
                EndsAt = endsAt,
                Priority = 10,
            },
            new Promotion
            {
                Name = "Buy 2 Get 1 Free",
                Description = "Buy 2, get 1 free on this item",
                Type = PromotionType.BuyXGetY,
                Value = 0m,
                BuyQuantity = 2,
                GetQuantity = 1,
                Targets = [new PromotionTarget { Scope = PromotionScope.Product, TargetId = 40 }],
                Status = PromotionStatus.Published,
                StartsAt = startsAt,
                EndsAt = endsAt,
                Priority = 6,
            },
            new Promotion
            {
                Name = "$10 off orders over $150",
                Description = "$10 off your order when you spend $150 or more",
                Type = PromotionType.AmountOffOrder,
                Value = 10m,
                MinOrderTotal = 150m,
                Targets = [new PromotionTarget { Scope = PromotionScope.All }],
                Status = PromotionStatus.Published,
                StartsAt = startsAt,
                EndsAt = endsAt,
                Priority = 8,
            },
            new Promotion
            {
                Name = "Coupon only: 10% off",
                Description = "10% off everything with a coupon code",
                Type = PromotionType.PercentOff,
                Value = 10m,
                Targets = [new PromotionTarget { Scope = PromotionScope.All }],
                Status = PromotionStatus.Published,
                StartsAt = startsAt,
                EndsAt = endsAt,
                Priority = 5,
                RequiresCoupon = true,
                Coupons =
                [
                    new Coupon { Code = "FALL10" },
                    new Coupon { Code = "WELCOME5" },
                ],
            });

        await context.SaveChangesAsync();
    }
}
