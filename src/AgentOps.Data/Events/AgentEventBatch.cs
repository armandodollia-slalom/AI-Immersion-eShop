using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentOps.Data.Events;

/// <summary>
/// The artifact the collect job writes for one PR head and the ingest job reads (schema agentops.batch/v1).
/// Every review and mistake carries a deterministic event_id, so re-ingesting a batch is a no-op.
/// </summary>
public sealed record AgentEventBatch
{
    public const string CurrentSchema = "agentops.batch/v1";

    public string Schema { get; init; } = CurrentSchema;
    public string BatchId { get; init; } = "";
    public DateTimeOffset CollectedAt { get; init; }
    public PullRequestInfo PullRequest { get; init; } = new();
    public List<ReviewEvent> Reviews { get; init; } = [];
    public List<MistakeEvent> Mistakes { get; init; } = [];
    public int Skipped { get; init; }

    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };
}

public sealed record PullRequestInfo
{
    public int Number { get; init; }
    public string Title { get; init; } = "";
    public string Author { get; init; } = "";
    public string Url { get; init; } = "";
    public string HeadSha { get; init; } = "";
    public string BaseSha { get; init; } = "";
    public List<string> Labels { get; init; } = [];
}

public sealed record ReviewEvent
{
    public string EventId { get; init; } = "";
    public string Agent { get; init; } = "";
    public string Source { get; init; } = "";
    public string? Story { get; init; }
    public string? Stage { get; init; }
    public int? Round { get; init; }
    public string Verdict { get; init; } = "";
    public bool Passed { get; init; }
    public int? Score { get; init; }
    public DateTimeOffset OccurredAt { get; init; }
}

public sealed record MistakeEvent
{
    public string EventId { get; init; } = "";
    public string? ReviewEventId { get; init; }
    public string Agent { get; init; } = "";
    public string Source { get; init; } = "";
    public string Category { get; init; } = "";
    public string? Rule { get; init; }
    public string? Subtype { get; init; }
    public string? Severity { get; init; }
    public string? File { get; init; }
    public int? Line { get; init; }
    public string? Message { get; init; }
    public string? Story { get; init; }
    public string? Stage { get; init; }
    public int? Round { get; init; }
    public DateTimeOffset OccurredAt { get; init; }

    /// <summary>What the agent got wrong, independent of where: the policy rule, or category/subtype.</summary>
    [JsonIgnore]
    public string Key => MistakeKeys.For(Rule, Category, Subtype);
}

public static class MistakeKeys
{
    public static string For(string? rule, string category, string? subtype) =>
        !string.IsNullOrWhiteSpace(rule) ? rule
        : !string.IsNullOrWhiteSpace(subtype) ? $"{category}/{subtype}"
        : category;
}
