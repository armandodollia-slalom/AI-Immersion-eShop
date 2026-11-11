namespace Promotions.API.Infrastructure;

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

        var couponOnly = new Promotion
        {
            Name = "Coupon only: 10% off",
            Type = PromotionType.PercentOff,
            Status = PromotionStatus.Published,
            StartsAt = startsAt,
            EndsAt = endsAt,
            Priority = 5,
            RequiresCoupon = true,
            PercentOff = 10m,
            Coupons =
            [
                new Coupon { Code = "FALL10" },
                new Coupon { Code = "WELCOME5" },
            ],
        };

        context.Promotions.AddRange(
            new Promotion
            {
                Name = "15% off everything",
                Type = PromotionType.PercentOff,
                Status = PromotionStatus.Published,
                StartsAt = startsAt,
                EndsAt = endsAt,
                Priority = 10,
                PercentOff = 15m,
            },
            new Promotion
            {
                Name = "$20 off your order",
                Type = PromotionType.AmountOffOrder,
                Status = PromotionStatus.Published,
                StartsAt = startsAt,
                EndsAt = endsAt,
                Priority = 8,
                AmountOff = 20m,
            },
            new Promotion
            {
                Name = "Buy 2 get 1 free",
                Type = PromotionType.BuyXGetY,
                Status = PromotionStatus.Published,
                StartsAt = startsAt,
                EndsAt = endsAt,
                Priority = 6,
                BuyQuantity = 2,
                GetQuantity = 1,
            },
            couponOnly);

        await context.SaveChangesAsync();
    }
}
