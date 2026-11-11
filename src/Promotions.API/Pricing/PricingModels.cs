using System.Text.Json.Serialization;

namespace Promotions.API.Pricing;

/// <summary>An immutable snapshot of a <see cref="Promotion"/> that the pricing engine works from (safe to cache and share).</summary>
public sealed record PromotionRule(
    int Id,
    string Name,
    string BadgeLabel,
    PromotionType Type,
    decimal Value,
    decimal? MinOrderTotal,
    int? BuyQuantity,
    int? GetQuantity,
    int Priority,
    bool IsStackable,
    bool RequiresCoupon,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    IReadOnlyList<PromotionRuleTarget> Targets)
{
    public static PromotionRule From(Promotion p) => new(
        p.Id, p.Name, p.GetBadgeLabel(), p.Type, p.Value, p.MinOrderTotal, p.BuyQuantity, p.GetQuantity,
        p.Priority, p.IsStackable, p.RequiresCoupon, p.StartsAt, p.EndsAt,
        p.Targets.OrderBy(t => t.Id).Select(t => new PromotionRuleTarget(t.Scope, t.TargetId)).ToList());

    /// <summary>True when any target matches the line: <c>All</c>, or the line's product, brand or type id.</summary>
    public bool Matches(EvaluateLine line) => Targets.Any(t => t.Scope switch
    {
        PromotionScope.All => true,
        PromotionScope.Product => t.TargetId == line.ProductId,
        PromotionScope.Brand => t.TargetId == line.CatalogBrandId,
        PromotionScope.Type => t.TargetId == line.CatalogTypeId,
        _ => false,
    });
}

public sealed record PromotionRuleTarget(PromotionScope Scope, int? TargetId);

/// <summary>One cart line as the caller priced it from the catalog.</summary>
public sealed record EvaluateLine(int ProductId, int CatalogTypeId, int CatalogBrandId, decimal UnitPrice, int Quantity);

/// <summary>The body of <c>POST /api/promotions/evaluate</c>.</summary>
public sealed record EvaluateRequest(string? CouponCode, IReadOnlyList<EvaluateLine>? Items);

/// <summary>The 200 body of <c>POST /api/promotions/evaluate</c>.</summary>
public sealed record PricingResult(
    decimal Subtotal,
    decimal TotalDiscount,
    decimal Total,
    IReadOnlyList<PricedLine> Lines,
    IReadOnlyList<AppliedPromotion> AppliedPromotions,
    CouponResult Coupon,
    NextThreshold? NextThreshold);

public sealed record PricedLine(int ProductId, decimal LineTotal, decimal Discount, IReadOnlyList<int> AppliedPromotionIds);

public sealed record AppliedPromotion(int Id, string Name, string BadgeLabel, decimal Savings);

/// <summary>The coupon part of the response; <see cref="Reason"/> is only written when the status is <c>Invalid</c>.</summary>
public sealed record CouponResult(
    string? Code,
    CouponStatus Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CouponInvalidReason? Reason)
{
    public static CouponResult From(CouponCheck check) =>
        new(check.Code, check.Status, check.Status == CouponStatus.Invalid ? check.Reason : null);
}

/// <summary>The closest <c>AmountOffOrder</c> promotion the cart has not reached yet (the "add $X more" message).</summary>
public sealed record NextThreshold(int PromotionId, decimal MinOrderTotal, decimal AmountRemaining, decimal Reward);
