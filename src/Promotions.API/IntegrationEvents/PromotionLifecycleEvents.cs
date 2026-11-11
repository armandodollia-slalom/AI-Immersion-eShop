using Promotions.API.IntegrationEvents.Events;

namespace Promotions.API.IntegrationEvents;

/// <summary>
/// The one rule for when a promotion's start and end events go out, shared by /publish, /end and
/// <see cref="Services.PromotionLifecycleWorker"/>. Marks each returned event as sent on the promotion, so saving the
/// promotion together with the events (one outbox transaction) makes each event go out exactly once.
/// </summary>
public static class PromotionLifecycleEvents
{
    public static List<IntegrationEvent> TakeDue(Promotion promotion, DateTimeOffset now)
    {
        var events = new List<IntegrationEvent>();

        if (promotion.IsStartedEventDue(now))
        {
            promotion.MarkStartedEventSent(now);
            events.Add(PromotionStartedIntegrationEvent.From(promotion));
        }

        if (promotion.IsEndedEventDue(now))
        {
            promotion.MarkEndedEventSent(now);
            events.Add(new PromotionEndedIntegrationEvent(promotion.Id));
        }

        return events;
    }
}
