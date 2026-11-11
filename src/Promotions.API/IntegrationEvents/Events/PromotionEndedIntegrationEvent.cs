namespace Promotions.API.IntegrationEvents.Events;

/// <summary>A started promotion reached its end time or an admin ended it. Sent once per promotion.</summary>
public record PromotionEndedIntegrationEvent(int PromotionId) : IntegrationEvent;
