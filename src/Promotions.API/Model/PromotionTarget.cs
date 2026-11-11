using System.Text.Json.Serialization;

namespace Promotions.API.Model;

/// <summary>What a promotion applies to. <c>All</c> has no target id; the others name a catalog brand, type or item id.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PromotionScope>))]
public enum PromotionScope
{
    All = 1,
    Brand = 2,
    Type = 3,
    Product = 4,
}

public class PromotionTarget
{
    public int Id { get; set; }

    public int PromotionId { get; set; }

    public PromotionScope Scope { get; set; }

    /// <summary>Catalog brand, type or item id; null only when <see cref="Scope"/> is <see cref="PromotionScope.All"/>.</summary>
    public int? TargetId { get; set; }
}
