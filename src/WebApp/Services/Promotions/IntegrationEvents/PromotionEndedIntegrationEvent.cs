using eShop.EventBus.Events;

namespace eShop.WebApp.Services.Promotions.IntegrationEvents;

public record PromotionEndedIntegrationEvent(int PromotionId) : IntegrationEvent;
