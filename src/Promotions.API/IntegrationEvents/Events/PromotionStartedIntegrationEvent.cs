namespace Promotions.API.IntegrationEvents.Events;

/// <summary>A published promotion's start time passed (or it was published after it started). Sent once per promotion.</summary>
public record PromotionStartedIntegrationEvent(
    int PromotionId,
    string Name,
    string Description,
    string BadgeLabel,
    DateTimeOffset EndsAt,
    IReadOnlyList<PromotionTargetItem> Targets) : IntegrationEvent
{
    public static PromotionStartedIntegrationEvent From(Promotion promotion) => new(
        promotion.Id,
        promotion.Name,
        promotion.Description,
        promotion.GetBadgeLabel(),
        promotion.EndsAt,
        promotion.Targets.OrderBy(t => t.Id).Select(t => new PromotionTargetItem(t.Scope, t.TargetId)).ToList());
}
