using eShop.EventBus.Abstractions;

namespace eShop.WebApp.Services.Promotions.IntegrationEvents;

public class PromotionStartedIntegrationEventHandler(
    PromotionsService promotionsService,
    ILogger<PromotionStartedIntegrationEventHandler> logger)
    : IIntegrationEventHandler<PromotionStartedIntegrationEvent>
{
    public Task Handle(PromotionStartedIntegrationEvent @event)
    {
        logger.LogInformation("Handling integration event: {IntegrationEventId} - ({@IntegrationEvent})", @event.Id, @event);
        promotionsService.InvalidateActive();
        return Task.CompletedTask;
    }
}
