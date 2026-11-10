using AgentOps.Data.Events;
using AgentOps.Data.Model;
using Microsoft.EntityFrameworkCore;

namespace AgentOps.Data.Ingestion;

public sealed record IngestResult(int PullRequestNumber, int ReviewsInserted, int MistakesInserted, int Skipped);

/// <summary>Writes a sanitized batch to agentopsdb in one transaction; safe to re-run for the same batch.</summary>
public sealed class BatchIngester(AgentOpsContext db, TimeProvider time)
{
    public async Task<IngestResult> IngestAsync(AgentEventBatch untrusted, CancellationToken cancellationToken)
    {
        var batch = BatchSanitizer.Sanitize(untrusted);
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async ct =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var now = time.GetUtcNow();

            var pr = await UpsertPullRequestAsync(batch.PullRequest, now, ct);
            var agents = await EnsureAgentsAsync(batch.Reviews.Select(r => r.Agent).Concat(batch.Mistakes.Select(m => m.Agent)), now, ct);

            var reviewIds = batch.Reviews.Select(r => r.EventId).ToList();
            var mistakeIds = batch.Mistakes.Select(m => m.EventId).ToList();
            var existingReviews = await db.ReviewRuns.Where(r => reviewIds.Contains(r.EventId)).Select(r => r.EventId).ToHashSetAsync(ct);
            var existingMistakes = await db.Mistakes.Where(m => mistakeIds.Contains(m.EventId)).Select(m => m.EventId).ToHashSetAsync(ct);
            var plan = IngestPlanner.Plan(batch, existingReviews, existingMistakes);

            var runs = plan.Reviews.ToDictionary(r => r.EventId, r => new ReviewRun
            {
                EventId = r.EventId,
                PullRequestId = pr.Id,
                AgentId = agents[r.Agent].Id,
                Source = r.Source,
                Story = r.Story,
                Stage = r.Stage,
                Round = r.Round,
                Verdict = r.Verdict,
                Passed = r.Passed,
                Score = r.Score,
                OccurredAt = r.OccurredAt.ToUniversalTime(),
            });
            db.ReviewRuns.AddRange(runs.Values);
            await db.SaveChangesAsync(ct);

            var linkIds = plan.Mistakes.Select(m => m.ReviewEventId).OfType<string>().Distinct().Where(id => !runs.ContainsKey(id)).ToList();
            var stored = await db.ReviewRuns.Where(r => linkIds.Contains(r.EventId)).Select(r => new { r.EventId, r.Id }).ToDictionaryAsync(r => r.EventId, r => r.Id, ct);

            db.Mistakes.AddRange(plan.Mistakes.Select(m => new Mistake
            {
                EventId = m.EventId,
                PullRequestId = pr.Id,
                AgentId = agents[m.Agent].Id,
                ReviewRunId = m.ReviewEventId is null ? null
                    : runs.TryGetValue(m.ReviewEventId, out var run) ? run.Id
                    : stored.TryGetValue(m.ReviewEventId, out var id) ? id
                    : null,
                Source = m.Source,
                Category = m.Category,
                Rule = m.Rule,
                Subtype = m.Subtype,
                Severity = m.Severity,
                File = m.File,
                Line = m.Line,
                Message = m.Message,
                MistakeKey = m.Key,
                Fingerprint = BatchCollector.EventId(m.Agent, m.Key, m.File ?? ""),
                Story = m.Story,
                Stage = m.Stage,
                Round = m.Round,
                OccurredAt = m.OccurredAt.ToUniversalTime(),
            }));

            var skipped = batch.Skipped + plan.Duplicates;
            db.IngestBatches.Add(new IngestBatch
            {
                BatchId = batch.BatchId,
                PullRequestId = pr.Id,
                HeadSha = batch.PullRequest.HeadSha,
                ReviewsInserted = plan.Reviews.Count,
                MistakesInserted = plan.Mistakes.Count,
                EventsSkipped = skipped,
                IngestedAt = now,
            });
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return new IngestResult(pr.Number, plan.Reviews.Count, plan.Mistakes.Count, skipped);
        }, cancellationToken);
    }

    private async Task<PullRequest> UpsertPullRequestAsync(PullRequestInfo info, DateTimeOffset now, CancellationToken ct)
    {
        var pr = await db.PullRequests.SingleOrDefaultAsync(p => p.Number == info.Number, ct);
        if (pr is null)
        {
            pr = new PullRequest { Number = info.Number, FirstSeenAt = now };
            db.PullRequests.Add(pr);
        }

        pr.Title = info.Title;
        pr.Author = info.Author;
        pr.Url = info.Url;
        pr.HeadSha = info.HeadSha;
        pr.Labels = string.Join(',', info.Labels);
        pr.LastIngestedAt = now;
        await db.SaveChangesAsync(ct);
        return pr;
    }

    private async Task<Dictionary<string, Agent>> EnsureAgentsAsync(IEnumerable<string> names, DateTimeOffset now, CancellationToken ct)
    {
        var wanted = names.Distinct().ToList();
        var agents = await db.Agents.Where(a => wanted.Contains(a.Name)).ToDictionaryAsync(a => a.Name, ct);
        foreach (var name in wanted.Where(n => !agents.ContainsKey(n)))
        {
            agents[name] = db.Agents.Add(new Agent { Name = name, FirstSeenAt = now }).Entity;
        }

        await db.SaveChangesAsync(ct);
        return agents;
    }
}
