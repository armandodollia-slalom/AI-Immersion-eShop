using eShop.EventBus.Events;
using eShop.WebAppComponents.Promotions;

namespace eShop.WebApp.Services.Promotions.IntegrationEvents;

public record PromotionStartedIntegrationEvent(
    int PromotionId,
    string Name,
    string Description,
    string BadgeLabel,
    DateTimeOffset EndsAt,
    IReadOnlyList<PromotionTarget> Targets) : IntegrationEvent;
