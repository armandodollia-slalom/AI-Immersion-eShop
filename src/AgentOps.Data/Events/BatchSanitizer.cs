using System.Text.RegularExpressions;

namespace AgentOps.Data.Events;

/// <summary>
/// The ingest job runs with database credentials on an artifact produced by untrusted PR code, so every batch is
/// validated and truncated to column limits before it touches the database.
/// </summary>
public static partial class BatchSanitizer
{
    public const int MaxEvents = 5000;

    public static AgentEventBatch Sanitize(AgentEventBatch batch)
    {
        if (batch.Schema != AgentEventBatch.CurrentSchema)
        {
            throw new InvalidDataException($"Unsupported batch schema '{Clip(batch.Schema, 64)}'.");
        }

        if (batch.PullRequest.Number <= 0)
        {
            throw new InvalidDataException("The batch has no pull request number.");
        }

        if (!IsEventId(batch.BatchId))
        {
            throw new InvalidDataException("The batch id is not a sha256 hex digest.");
        }

        if (batch.Reviews.Count + batch.Mistakes.Count > MaxEvents)
        {
            throw new InvalidDataException($"The batch has more than {MaxEvents} events.");
        }

        var pr = batch.PullRequest;
        var reviews = batch.Reviews.Where(r => IsEventId(r.EventId) && PipelineAgents.IsPipelineAgent(r.Agent)).ToList();
        var mistakes = batch.Mistakes.Where(m => IsEventId(m.EventId) && PipelineAgents.IsPipelineAgent(m.Agent)).ToList();
        return batch with
        {
            PullRequest = pr with
            {
                Title = Clip(pr.Title, Limits.Title),
                Author = Clip(pr.Author, Limits.Short),
                Url = Clip(pr.Url, Limits.Url),
                HeadSha = Clip(pr.HeadSha, 64),
                BaseSha = Clip(pr.BaseSha, 64),
                Labels = pr.Labels.Take(50).Select(l => Clip(l, Limits.Short)).ToList(),
            },
            Reviews = reviews.Select(r => r with
            {
                Source = Clip(r.Source, Limits.Short),
                Story = ClipOrNull(r.Story, Limits.Short),
                Stage = ClipOrNull(r.Stage, Limits.Short),
                Verdict = Clip(r.Verdict, Limits.Short),
            }).ToList(),
            Mistakes = mistakes.Select(m => m with
            {
                ReviewEventId = m.ReviewEventId is not null && IsEventId(m.ReviewEventId) ? m.ReviewEventId : null,
                Source = Clip(m.Source, Limits.Short),
                Category = Clip(m.Category, Limits.Short),
                Rule = ClipOrNull(m.Rule, Limits.Short),
                Subtype = ClipOrNull(m.Subtype, Limits.Short),
                Severity = ClipOrNull(m.Severity, 32),
                File = ClipOrNull(m.File, Limits.Url),
                Message = ClipOrNull(m.Message, Limits.Message),
                Story = ClipOrNull(m.Story, Limits.Short),
                Stage = ClipOrNull(m.Stage, Limits.Short),
            }).ToList(),
            Skipped = batch.Skipped + (batch.Reviews.Count - reviews.Count) + (batch.Mistakes.Count - mistakes.Count),
        };
    }

    public static bool IsEventId(string? value) => value is not null && EventIdPattern().IsMatch(value);

    private static string Clip(string? value, int max) => ClipOrNull(value, max) ?? "";

    private static string? ClipOrNull(string? value, int max)
    {
        if (value is null)
        {
            return null;
        }

        var clean = new string(value.Where(c => !char.IsControl(c) || c == '\n').ToArray());
        return clean.Length <= max ? clean : clean[..(max - 1)] + "…";
    }

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex EventIdPattern();
}
