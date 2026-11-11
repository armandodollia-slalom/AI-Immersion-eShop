using System.Text.Json.Serialization;

namespace Promotions.API.Services;

/// <summary>
/// Checks a coupon code for a buyer and cart. PROMO-3 only reports the result (see <see cref="NotProvidedCouponValidator"/>);
/// PROMO-4 supplies the real implementation (limits, expiry, minimum order). Validation has no side effects: coupons are
/// redeemed when an order is paid, never here.
/// </summary>
public interface ICouponValidator
{
    /// <param name="code">The code as the shopper typed it (case-insensitive), or null when none was given.</param>
    /// <param name="buyerId">The caller's <c>sub</c> claim.</param>
    /// <param name="orderSubtotal">The cart subtotal before discounts, for minimum-order checks; null when unknown.</param>
    Task<CouponCheck> ValidateAsync(string? code, string buyerId, decimal? orderSubtotal, CancellationToken cancellationToken);
}

/// <summary>The result of a coupon check.</summary>
/// <param name="Code">The code checked, or null when none was given.</param>
/// <param name="Status">Whether the coupon applies.</param>
/// <param name="PromotionId">The coupon-only promotion it unlocks; set only when <paramref name="Status"/> is <see cref="CouponStatus.Applied"/>.</param>
/// <param name="Reason">Why it does not apply; set only when <paramref name="Status"/> is <see cref="CouponStatus.Invalid"/>.</param>
public record CouponCheck(string? Code, CouponStatus Status, int? PromotionId, CouponInvalidReason? Reason)
{
    public static CouponCheck NotProvided { get; } = new(null, CouponStatus.NotProvided, null, null);
}

[JsonConverter(typeof(JsonStringEnumConverter<CouponStatus>))]
public enum CouponStatus
{
    Applied = 1,
    Invalid = 2,
    NotProvided = 3,
}

[JsonConverter(typeof(JsonStringEnumConverter<CouponInvalidReason>))]
public enum CouponInvalidReason
{
    NotFound = 1,
    Expired = 2,
    UsageLimitReached = 3,
    PerUserLimitReached = 4,
    MinOrderNotMet = 5,
}
