namespace AgentOps.Data.Reporting;

public sealed record ReviewRow(
    int PrNumber, string Agent, string Source, string? Story, string? Stage, int? Round,
    string Verdict, bool Passed, int? Score, DateTimeOffset OccurredAt);

public sealed record MistakeRow(
    int PrNumber, string Agent, string Source, string Key, string Category, string? Rule, string? Severity,
    string? File, int? Line, string? Message, string? Stage, int? Round, DateTimeOffset OccurredAt);

public sealed record MistakeGroup(
    string Key, int Count, int PullRequests, string? Severity, IReadOnlyList<string> Files, string? Example, int PriorPullRequests);

public sealed record AgentPrSummary(
    string Agent, int ReviewRuns, int ReviewSeries, int FirstPassApproved, double? AverageRoundsToApproval,
    int Mistakes, int BlockingMistakes, int EscapedMistakes, IReadOnlyList<MistakeGroup> MistakeGroups);

public sealed record PrReport(int Number, string Title, string Url, string Author, IReadOnlyList<AgentPrSummary> Agents);

public sealed record AgentRollup(
    string Agent, int PullRequests, int ReviewRuns, double? FirstPassRate, double? AverageRoundsToApproval,
    int Mistakes, int BlockingMistakes, int EscapedMistakes, IReadOnlyList<MistakeGroup> TopMistakes);

public sealed record RepeatMistake(string Agent, string Key, int PullRequests, int Count, DateTimeOffset LastSeen);

public sealed record Hotspot(string File, int Mistakes, int PullRequests);

public sealed record RollupReport(
    DateTimeOffset From, DateTimeOffset To, int PullRequests, IReadOnlyList<AgentRollup> Agents,
    IReadOnlyList<RepeatMistake> RepeatMistakes, IReadOnlyList<Hotspot> Hotspots);

public sealed record PrListItem(int Number, string Title, string Author, string Url, int ReviewRuns, int Mistakes, DateTimeOffset LastIngestedAt);
