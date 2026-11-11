using Promotions.API.IntegrationEvents;

namespace Promotions.API.Services;

/// <summary>
/// Sends <c>PromotionStartedIntegrationEvent</c> once a published promotion's <c>StartsAt</c> passes and
/// <c>PromotionEndedIntegrationEvent</c> once a started promotion's <c>EndsAt</c> passes (or it was ended), every 30 seconds.
/// <c>StartedEventSentAt</c>/<c>EndedEventSentAt</c> record what was sent, so each event goes out exactly once.
/// EffectiveStatus is computed, so this worker never changes a promotion's status.
/// </summary>
public sealed class PromotionLifecycleWorker(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ILogger<PromotionLifecycleWorker> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval, timeProvider);
        do
        {
            try
            {
                await SendDueEventsAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Promotion lifecycle run failed; retrying in {Interval}", Interval);
            }
        }
        while (await WaitForNextTickAsync(timer, stoppingToken));
    }

    private static async Task<bool> WaitForNextTickAsync(PeriodicTimer timer, CancellationToken stoppingToken)
    {
        try
        {
            return await timer.WaitForNextTickAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>One run: writes every due start and end event to the outbox, then publishes them.</summary>
    public async Task SendDueEventsAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<PromotionsContext>();
        var eventService = scope.ServiceProvider.GetRequiredService<IPromotionsIntegrationEventService>();
        var now = timeProvider.GetUtcNow();

        // Published and not started yet but due, or started and now expired (EndsAt passed or ended by an admin) without an end event.
        var candidates = await context.Promotions
            .Include(p => p.Targets)
            .Where(p =>
                (p.StartedEventSentAt == null && p.Status == PromotionStatus.Published && p.StartsAt <= now && now < p.EndsAt)
                || (p.StartedEventSentAt != null && p.EndedEventSentAt == null && (p.Status == PromotionStatus.Ended || p.EndsAt <= now)))
            .OrderBy(p => p.Id)
            .AsSplitQuery()
            .ToListAsync(cancellationToken);

        foreach (var promotion in candidates)
        {
            var events = PromotionLifecycleEvents.TakeDue(promotion, now);
            if (events.Count == 0)
            {
                continue;
            }

            try
            {
                await eventService.SaveEventsAndPromotionsContextChangesAsync(events, cancellationToken);
            }
            catch (DbUpdateConcurrencyException)
            {
                // An admin call (or another instance) changed the promotion meanwhile; the next run looks again.
                logger.LogInformation("Promotion {PromotionId} changed during the lifecycle run; retrying next run", promotion.Id);
                context.Entry(promotion).State = EntityState.Detached;
                continue;
            }

            foreach (var evt in events)
            {
                await eventService.PublishThroughEventBusAsync(evt);
            }
        }
    }
}
