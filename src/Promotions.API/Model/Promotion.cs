namespace Promotions.API.Model;

public enum PromotionType
{
    PercentOff = 1,
    AmountOffOrder = 2,
    BuyXGetY = 3,
}

public enum PromotionStatus
{
    Draft = 1,
    Published = 2,
    Archived = 3,
}

public enum PromotionTargetType
{
    CatalogItem = 1,
    CatalogBrand = 2,
    CatalogType = 3,
}

public class Promotion
{
    public int Id { get; set; }

    public required string Name { get; set; }

    public PromotionType Type { get; set; }

    public PromotionStatus Status { get; set; }

    public DateTimeOffset StartsAt { get; set; }

    public DateTimeOffset EndsAt { get; set; }

    /// <summary>Higher priority promotions are applied first.</summary>
    public int Priority { get; set; }

    public bool RequiresCoupon { get; set; }

    /// <summary>Discount percentage (0-100) for <see cref="PromotionType.PercentOff"/>.</summary>
    public decimal? PercentOff { get; set; }

    /// <summary>Order-level amount for <see cref="PromotionType.AmountOffOrder"/>.</summary>
    public decimal? AmountOff { get; set; }

    /// <summary>Quantity to buy for <see cref="PromotionType.BuyXGetY"/>.</summary>
    public int? BuyQuantity { get; set; }

    /// <summary>Quantity received free for <see cref="PromotionType.BuyXGetY"/>.</summary>
    public int? GetQuantity { get; set; }

    public List<PromotionTarget> Targets { get; set; } = [];

    public List<Coupon> Coupons { get; set; } = [];
}

public class PromotionTarget
{
    public int Id { get; set; }

    public int PromotionId { get; set; }

    public PromotionTargetType TargetType { get; set; }

    public int TargetId { get; set; }
}

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
