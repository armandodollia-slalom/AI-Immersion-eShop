namespace Promotions.API.Model;

// Coupon tables are unchanged from PROMO-1 (PROMO-4 reshapes them).
public class Coupon
{
    public int Id { get; set; }

    public int PromotionId { get; set; }

    public required string Code { get; set; }

    public int? MaxRedemptions { get; set; }

    public List<CouponRedemption> Redemptions { get; set; } = [];
}

public class CouponRedemption
{
    public int Id { get; set; }

    public int CouponId { get; set; }

    public required string UserId { get; set; }

    public int? OrderId { get; set; }

    public DateTimeOffset RedeemedAt { get; set; }
}
