namespace Promotions.API.IntegrationEvents;

public interface IPromotionsIntegrationEventService
{
    /// <summary>Saves the context changes and writes the events to the outbox in one transaction.</summary>
    Task SaveEventsAndPromotionsContextChangesAsync(IReadOnlyCollection<IntegrationEvent> events, CancellationToken cancellationToken = default);

    /// <summary>Publishes an event already saved to the outbox and records the outcome there.</summary>
    Task PublishThroughEventBusAsync(IntegrationEvent evt);
}

/// <summary>The IntegrationEventLogEF outbox for PromotionsContext (the pattern of Catalog.API's CatalogIntegrationEventService).</summary>
public sealed class PromotionsIntegrationEventService(
    ILogger<PromotionsIntegrationEventService> logger,
    IEventBus eventBus,
    PromotionsContext context,
    IIntegrationEventLogService integrationEventLogService) : IPromotionsIntegrationEventService
{
    public async Task SaveEventsAndPromotionsContextChangesAsync(IReadOnlyCollection<IntegrationEvent> events, CancellationToken cancellationToken = default)
    {
        if (events.Count == 0)
        {
            await context.SaveChangesAsync(cancellationToken);
            return;
        }

        // Atomicity between the promotion change (e.g. StartedEventSentAt) and the outbox rows: one local transaction.
        await ResilientTransaction.New(context).ExecuteAsync(async () =>
        {
            await context.SaveChangesAsync(cancellationToken);
            foreach (var evt in events)
            {
                logger.LogInformation("Saving integration event {IntegrationEventId} ({IntegrationEventName}) to the outbox", evt.Id, evt.GetType().Name);
                await integrationEventLogService.SaveEventAsync(evt, context.Database.CurrentTransaction!);
            }
        });
    }

    public async Task PublishThroughEventBusAsync(IntegrationEvent evt)
    {
        try
        {
            logger.LogInformation("Publishing integration event: {IntegrationEventId} - ({@IntegrationEvent})", evt.Id, evt);

            await integrationEventLogService.MarkEventAsInProgressAsync(evt.Id);
            await eventBus.PublishAsync(evt);
            await integrationEventLogService.MarkEventAsPublishedAsync(evt.Id);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error publishing integration event: {IntegrationEventId} - ({@IntegrationEvent})", evt.Id, evt);
            await integrationEventLogService.MarkEventAsFailedAsync(evt.Id);
        }
    }
}
