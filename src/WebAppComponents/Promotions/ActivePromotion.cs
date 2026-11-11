using System.Text.Json.Serialization;

namespace eShop.WebAppComponents.Promotions;

[JsonConverter(typeof(JsonStringEnumConverter<PromotionType>))]
public enum PromotionType
{
    PercentOff = 1,
    AmountOffOrder = 2,
    BuyXGetY = 3,
}

[JsonConverter(typeof(JsonStringEnumConverter<PromotionScope>))]
public enum PromotionScope
{
    All = 1,
    Brand = 2,
    Type = 3,
    Product = 4,
}

/// <summary>An element of the Promotions.API <c>/active</c> response.</summary>
public record ActivePromotion(
    int Id,
    string Name,
    string Description,
    PromotionType Type,
    decimal Value,
    string BadgeLabel,
    IReadOnlyList<PromotionTarget> Targets,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    int Priority,
    bool RequiresCoupon);

public record PromotionTarget(PromotionScope Scope, int? TargetId);
