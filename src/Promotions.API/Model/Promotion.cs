using System.Globalization;
using System.Linq.Expressions;
using System.Text.Json.Serialization;

namespace Promotions.API.Model;

[JsonConverter(typeof(JsonStringEnumConverter<PromotionType>))]
public enum PromotionType
{
    PercentOff = 1,
    AmountOffOrder = 2,
    BuyXGetY = 3,
}

/// <summary>The stored lifecycle state an admin sets. See <see cref="PromotionEffectiveStatus"/> for what shoppers see.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PromotionStatus>))]
public enum PromotionStatus
{
    Draft = 1,
    Published = 2,
    Ended = 3,
}

/// <summary>Computed from <see cref="PromotionStatus"/> and the current time; never stored.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<PromotionEffectiveStatus>))]
public enum PromotionEffectiveStatus
{
    Draft = 1,
    Scheduled = 2,
    Active = 3,
    Expired = 4,
}

/// <summary>
/// The Promotion aggregate: a discount rule with a time window. Lifecycle changes go through
/// <see cref="Publish"/>, <see cref="End"/> and the event-sent markers so the start and end events are sent once.
/// </summary>
public class Promotion
{
    public const int NameMaxLength = 100;
    public const int DescriptionMaxLength = 500;

    public int Id { get; set; }

    public required string Name { get; set; }

    /// <summary>Shown on banners.</summary>
    public string Description { get; set; } = string.Empty;

    public PromotionType Type { get; set; }

    /// <summary>Percent (0, 100] for <see cref="PromotionType.PercentOff"/>, amount for <see cref="PromotionType.AmountOffOrder"/>, 0 for <see cref="PromotionType.BuyXGetY"/>.</summary>
    public decimal Value { get; set; }

    /// <summary>Order subtotal the cart must reach; required for <see cref="PromotionType.AmountOffOrder"/>.</summary>
    public decimal? MinOrderTotal { get; set; }

    /// <summary>Quantity to buy for <see cref="PromotionType.BuyXGetY"/>.</summary>
    public int? BuyQuantity { get; set; }

    /// <summary>Quantity received free for <see cref="PromotionType.BuyXGetY"/>.</summary>
    public int? GetQuantity { get; set; }

    public DateTimeOffset StartsAt { get; set; }

    public DateTimeOffset EndsAt { get; set; }

    /// <summary>The higher value wins a tie.</summary>
    public int Priority { get; set; }

    public bool IsStackable { get; set; }

    public bool RequiresCoupon { get; set; }

    public PromotionStatus Status { get; set; } = PromotionStatus.Draft;

    /// <summary>When <c>PromotionStartedIntegrationEvent</c> was written to the outbox; null until then.</summary>
    public DateTimeOffset? StartedEventSentAt { get; set; }

    /// <summary>When <c>PromotionEndedIntegrationEvent</c> was written to the outbox; null until then.</summary>
    public DateTimeOffset? EndedEventSentAt { get; set; }

    /// <summary>Optimistic concurrency token (Postgres <c>xmin</c>), so the lifecycle worker and admin calls never both send an event.</summary>
    public uint Version { get; set; }

    public List<PromotionTarget> Targets { get; set; } = [];

    public List<Coupon> Coupons { get; set; } = [];

    public PromotionEffectiveStatus GetEffectiveStatus(DateTimeOffset now) => Status switch
    {
        PromotionStatus.Draft => PromotionEffectiveStatus.Draft,
        PromotionStatus.Ended => PromotionEffectiveStatus.Expired,
        _ when now < StartsAt => PromotionEffectiveStatus.Scheduled,
        _ when now < EndsAt => PromotionEffectiveStatus.Active,
        _ => PromotionEffectiveStatus.Expired,
    };

    /// <summary>Only <c>Draft</c> and <c>Scheduled</c> promotions may be edited.</summary>
    public bool CanEdit(DateTimeOffset now) =>
        GetEffectiveStatus(now) is PromotionEffectiveStatus.Draft or PromotionEffectiveStatus.Scheduled;

    /// <summary>Changes <c>Draft</c> to <c>Published</c>. Returns false when the promotion is not a draft.</summary>
    public bool Publish()
    {
        if (Status != PromotionStatus.Draft)
        {
            return false;
        }

        Status = PromotionStatus.Published;
        return true;
    }

    /// <summary>Ends the promotion at once, whatever its state.</summary>
    public void End() => Status = PromotionStatus.Ended;

    /// <summary>True when the start event is due: published, inside its window and not sent yet.</summary>
    public bool IsStartedEventDue(DateTimeOffset now) =>
        StartedEventSentAt is null && GetEffectiveStatus(now) == PromotionEffectiveStatus.Active;

    /// <summary>True when the end event is due: the start event went out, the promotion is now expired and the end event was not sent.</summary>
    public bool IsEndedEventDue(DateTimeOffset now) =>
        StartedEventSentAt is not null && EndedEventSentAt is null && GetEffectiveStatus(now) == PromotionEffectiveStatus.Expired;

    public void MarkStartedEventSent(DateTimeOffset now) => StartedEventSentAt = now;

    public void MarkEndedEventSent(DateTimeOffset now) => EndedEventSentAt = now;

    public string GetBadgeLabel() => BadgeLabel(Type, Value, BuyQuantity, GetQuantity);

    /// <summary>The storefront badge: <c>-20%</c>, <c>Buy 2 Get 1</c> or <c>$10 off</c>.</summary>
    public static string BadgeLabel(PromotionType type, decimal value, int? buyQuantity, int? getQuantity) => type switch
    {
        PromotionType.PercentOff => string.Create(CultureInfo.InvariantCulture, $"-{value:0.##}%"),
        PromotionType.BuyXGetY => string.Create(CultureInfo.InvariantCulture, $"Buy {buyQuantity} Get {getQuantity}"),
        PromotionType.AmountOffOrder => string.Create(CultureInfo.InvariantCulture, $"${value:0.##} off"),
        _ => string.Empty,
    };

    /// <summary>Translatable filter: promotions whose effective status at <paramref name="now"/> is <paramref name="status"/>.</summary>
    public static Expression<Func<Promotion, bool>> HasEffectiveStatus(PromotionEffectiveStatus status, DateTimeOffset now) => status switch
    {
        PromotionEffectiveStatus.Draft => p => p.Status == PromotionStatus.Draft,
        PromotionEffectiveStatus.Scheduled => p => p.Status == PromotionStatus.Published && now < p.StartsAt,
        PromotionEffectiveStatus.Active => p => p.Status == PromotionStatus.Published && p.StartsAt <= now && now < p.EndsAt,
        PromotionEffectiveStatus.Expired => p => p.Status == PromotionStatus.Ended || (p.Status == PromotionStatus.Published && p.EndsAt <= now),
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null),
    };
}
