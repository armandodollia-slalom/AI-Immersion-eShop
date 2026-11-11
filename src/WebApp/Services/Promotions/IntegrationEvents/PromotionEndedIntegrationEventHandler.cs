using eShop.EventBus.Abstractions;

namespace eShop.WebApp.Services.Promotions.IntegrationEvents;

public class PromotionEndedIntegrationEventHandler(
    PromotionsService promotionsService,
    ILogger<PromotionEndedIntegrationEventHandler> logger)
    : IIntegrationEventHandler<PromotionEndedIntegrationEvent>
{
    public Task Handle(PromotionEndedIntegrationEvent @event)
    {
        logger.LogInformation("Handling integration event: {IntegrationEventId} - ({@IntegrationEvent})", @event.Id, @event);
        promotionsService.InvalidateActive();
        return Task.CompletedTask;
    }
}
