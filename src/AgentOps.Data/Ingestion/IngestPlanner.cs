using AgentOps.Data.Events;

namespace AgentOps.Data.Ingestion;

public sealed record IngestPlan(IReadOnlyList<ReviewEvent> Reviews, IReadOnlyList<MistakeEvent> Mistakes, int Duplicates);

/// <summary>Decides which events of a batch are new: event ids already stored, or repeated in the batch, are skipped.</summary>
public static class IngestPlanner
{
    public static IngestPlan Plan(AgentEventBatch batch, IReadOnlySet<string> existingReviewIds, IReadOnlySet<string> existingMistakeIds)
    {
        var reviews = batch.Reviews.DistinctBy(r => r.EventId).Where(r => !existingReviewIds.Contains(r.EventId)).ToList();
        var mistakes = batch.Mistakes.DistinctBy(m => m.EventId).Where(m => !existingMistakeIds.Contains(m.EventId)).ToList();
        var duplicates = batch.Reviews.Count - reviews.Count + batch.Mistakes.Count - mistakes.Count;
        return new IngestPlan(reviews, mistakes, duplicates);
    }
}
