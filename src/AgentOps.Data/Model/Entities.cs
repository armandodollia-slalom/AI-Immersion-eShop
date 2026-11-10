namespace AgentOps.Data.Model;

/// <summary>A pipeline agent whose work is reviewed (implementer, qe-plan, qe-automation).</summary>
public sealed class Agent
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public DateTimeOffset FirstSeenAt { get; set; }
}

/// <summary>A pull request whose review telemetry was ingested.</summary>
public sealed class PullRequest
{
    public int Id { get; set; }
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public string Author { get; set; } = "";
    public string Url { get; set; } = "";
    public string HeadSha { get; set; } = "";
    public string Labels { get; set; } = "";
    public DateTimeOffset FirstSeenAt { get; set; }
    public DateTimeOffset LastIngestedAt { get; set; }
}

/// <summary>One review round of an agent's work (architecture review, verifier run, precheck or the final PR policy review).</summary>
public sealed class ReviewRun
{
    public long Id { get; set; }
    public required string EventId { get; set; }
    public int PullRequestId { get; set; }
    public PullRequest? PullRequest { get; set; }
    public int AgentId { get; set; }
    public Agent? Agent { get; set; }
    public required string Source { get; set; }
    public string? Story { get; set; }
    public string? Stage { get; set; }
    public int? Round { get; set; }
    public required string Verdict { get; set; }
    public bool Passed { get; set; }
    public int? Score { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}

/// <summary>One mistake (finding, gap or precheck error) attributed to an agent.</summary>
public sealed class Mistake
{
    public long Id { get; set; }
    public required string EventId { get; set; }
    public int PullRequestId { get; set; }
    public PullRequest? PullRequest { get; set; }
    public int AgentId { get; set; }
    public Agent? Agent { get; set; }
    public long? ReviewRunId { get; set; }
    public ReviewRun? ReviewRun { get; set; }
    public required string Source { get; set; }
    public required string Category { get; set; }
    public string? Rule { get; set; }
    public string? Subtype { get; set; }
    public string? Severity { get; set; }
    public string? File { get; set; }
    public int? Line { get; set; }
    public string? Message { get; set; }
    public required string MistakeKey { get; set; }
    public required string Fingerprint { get; set; }
    public string? Story { get; set; }
    public string? Stage { get; set; }
    public int? Round { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}

/// <summary>Audit record of one ingested batch (one CI run for one PR head).</summary>
public sealed class IngestBatch
{
    public long Id { get; set; }
    public required string BatchId { get; set; }
    public int PullRequestId { get; set; }
    public string HeadSha { get; set; } = "";
    public int ReviewsInserted { get; set; }
    public int MistakesInserted { get; set; }
    public int EventsSkipped { get; set; }
    public DateTimeOffset IngestedAt { get; set; }
}
