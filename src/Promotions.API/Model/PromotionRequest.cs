namespace Promotions.API.Model;

/// <summary>Body of <c>POST /api/promotions</c> and <c>PUT /api/promotions/{id}</c>. Fields are nullable so a missing one is a validation error, not a binding failure.</summary>
public record PromotionRequest(
    string? Name,
    string? Description,
    PromotionType? Type,
    decimal? Value,
    decimal? MinOrderTotal,
    int? BuyQuantity,
    int? GetQuantity,
    List<PromotionTargetRequest>? Targets,
    DateTimeOffset? StartsAt,
    DateTimeOffset? EndsAt,
    int Priority = 0,
    bool IsStackable = false,
    bool RequiresCoupon = false);

public record PromotionTargetRequest(PromotionScope? Scope, int? TargetId);

/// <summary>A target in API responses and integration events.</summary>
public record PromotionTargetItem(PromotionScope Scope, int? TargetId);

/// <summary>The admin view: the whole aggregate plus its computed status and badge.</summary>
public record PromotionDetails(
    int Id,
    string Name,
    string Description,
    PromotionType Type,
    decimal Value,
    decimal? MinOrderTotal,
    int? BuyQuantity,
    int? GetQuantity,
    IReadOnlyList<PromotionTargetItem> Targets,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    int Priority,
    bool IsStackable,
    bool RequiresCoupon,
    PromotionStatus Status,
    PromotionEffectiveStatus EffectiveStatus,
    string BadgeLabel,
    DateTimeOffset? StartedEventSentAt,
    DateTimeOffset? EndedEventSentAt)
{
    public static PromotionDetails From(Promotion p, DateTimeOffset now) => new(
        p.Id, p.Name, p.Description, p.Type, p.Value, p.MinOrderTotal, p.BuyQuantity, p.GetQuantity,
        p.Targets.OrderBy(t => t.Id).Select(t => new PromotionTargetItem(t.Scope, t.TargetId)).ToList(),
        p.StartsAt, p.EndsAt, p.Priority, p.IsStackable, p.RequiresCoupon,
        p.Status, p.GetEffectiveStatus(now), p.GetBadgeLabel(), p.StartedEventSentAt, p.EndedEventSentAt);
}

/// <summary>The public storefront shape of <c>GET /api/promotions/active</c>.</summary>
public record ActivePromotion(
    int Id,
    string Name,
    string Description,
    PromotionType Type,
    decimal Value,
    string BadgeLabel,
    IReadOnlyList<PromotionTargetItem> Targets,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    int Priority,
    bool RequiresCoupon)
{
    public static ActivePromotion From(Promotion p) => new(
        p.Id, p.Name, p.Description, p.Type, p.Value, p.GetBadgeLabel(),
        p.Targets.OrderBy(t => t.Id).Select(t => new PromotionTargetItem(t.Scope, t.TargetId)).ToList(),
        p.StartsAt, p.EndsAt, p.Priority, p.RequiresCoupon);
}

public class PaginatedItems<TEntity>(int pageIndex, int pageSize, long count, IEnumerable<TEntity> data) where TEntity : class
{
    public int PageIndex { get; } = pageIndex;

    public int PageSize { get; } = pageSize;

    public long Count { get; } = count;

    public IEnumerable<TEntity> Data { get; } = data;
}
