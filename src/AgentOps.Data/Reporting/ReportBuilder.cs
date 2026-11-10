using AgentOps.Data.Events;

namespace AgentOps.Data.Reporting;

/// <summary>Computes the PR report and the rollup from loaded rows; pure so the metrics are unit-testable.</summary>
public static class ReportBuilder
{
    private const string PrecheckSource = "precheck";

    public static PrReport BuildPrReport(
        int number, string title, string url, string author,
        IReadOnlyList<ReviewRow> reviews, IReadOnlyList<MistakeRow> mistakes,
        IReadOnlyDictionary<(string Agent, string Key), int> priorPullRequests)
    {
        var agents = reviews.Select(r => r.Agent).Concat(mistakes.Select(m => m.Agent)).Distinct().Order(StringComparer.Ordinal);
        return new PrReport(number, title, url, author, agents.Select(agent =>
        {
            var agentReviews = reviews.Where(r => r.Agent == agent).ToList();
            var agentMistakes = mistakes.Where(m => m.Agent == agent).ToList();
            var series = Series(agentReviews);
            return new AgentPrSummary(
                agent,
                agentReviews.Count,
                series.Count,
                series.Count(s => s[0].Passed),
                AverageRoundsToApproval(series),
                agentMistakes.Count,
                agentMistakes.Count(IsBlocking),
                agentMistakes.Count(m => m.Source == BatchCollector.PolicyFinalSource),
                Group(agentMistakes, key => priorPullRequests.GetValueOrDefault((agent, key))));
        }).ToList());
    }

    public static RollupReport BuildRollup(DateTimeOffset from, DateTimeOffset to, IReadOnlyList<ReviewRow> reviews, IReadOnlyList<MistakeRow> mistakes)
    {
        var agents = reviews.Select(r => r.Agent).Concat(mistakes.Select(m => m.Agent)).Distinct().Order(StringComparer.Ordinal);
        var rollups = agents.Select(agent =>
        {
            var agentReviews = reviews.Where(r => r.Agent == agent).ToList();
            var agentMistakes = mistakes.Where(m => m.Agent == agent).ToList();
            var series = Series(agentReviews);
            return new AgentRollup(
                agent,
                agentReviews.Select(r => r.PrNumber).Concat(agentMistakes.Select(m => m.PrNumber)).Distinct().Count(),
                agentReviews.Count,
                series.Count == 0 ? null : Math.Round((double)series.Count(s => s[0].Passed) / series.Count, 3),
                AverageRoundsToApproval(series),
                agentMistakes.Count,
                agentMistakes.Count(IsBlocking),
                agentMistakes.Count(m => m.Source == BatchCollector.PolicyFinalSource),
                Group(agentMistakes, _ => 0).Take(5).ToList());
        }).ToList();

        var repeats = mistakes
            .GroupBy(m => (m.Agent, m.Key))
            .Select(g => new RepeatMistake(g.Key.Agent, g.Key.Key, g.Select(m => m.PrNumber).Distinct().Count(), g.Count(), g.Max(m => m.OccurredAt)))
            .Where(r => r.PullRequests >= 2)
            .OrderByDescending(r => r.PullRequests).ThenByDescending(r => r.Count).ThenBy(r => r.Key, StringComparer.Ordinal)
            .Take(20)
            .ToList();

        var hotspots = mistakes
            .Where(m => !string.IsNullOrEmpty(m.File))
            .GroupBy(m => m.File!)
            .Select(g => new Hotspot(g.Key, g.Count(), g.Select(m => m.PrNumber).Distinct().Count()))
            .OrderByDescending(h => h.Mistakes).ThenBy(h => h.File, StringComparer.Ordinal)
            .Take(10)
            .ToList();

        var prs = reviews.Select(r => r.PrNumber).Concat(mistakes.Select(m => m.PrNumber)).Distinct().Count();
        return new RollupReport(from, to, prs, rollups, repeats, hotspots);
    }

    // A series is one reviewer looking at one story/stage of one PR over successive rounds; precheck only logs failures.
    internal static List<List<ReviewRow>> Series(IEnumerable<ReviewRow> reviews) =>
        reviews.Where(r => r.Source != PrecheckSource)
               .GroupBy(r => (r.PrNumber, r.Source, r.Story, r.Stage))
               .Select(g => g.OrderBy(r => r.Round ?? 0).ThenBy(r => r.OccurredAt).ToList())
               .ToList();

    private static double? AverageRoundsToApproval(List<List<ReviewRow>> series)
    {
        var rounds = series
            .Select(s => s.FindIndex(r => r.Passed))
            .Where(i => i >= 0)
            .Select(i => i + 1.0)
            .ToList();
        return rounds.Count == 0 ? null : Math.Round(rounds.Average(), 2);
    }

    private static bool IsBlocking(MistakeRow m) => m.Severity is "blocking" or "critical" or "high";

    private static List<MistakeGroup> Group(IEnumerable<MistakeRow> mistakes, Func<string, int> prior) =>
        mistakes.GroupBy(m => m.Key)
                .Select(g => new MistakeGroup(
                    g.Key,
                    g.Count(),
                    g.Select(m => m.PrNumber).Distinct().Count(),
                    g.Any(IsBlocking) ? "blocking" : g.Select(m => m.Severity).FirstOrDefault(s => s is not null),
                    g.Select(m => m.File).OfType<string>().Distinct().Order(StringComparer.Ordinal).Take(3).ToList(),
                    g.Select(m => m.Message).FirstOrDefault(s => !string.IsNullOrWhiteSpace(s)),
                    prior(g.Key)))
                .OrderByDescending(g => g.Count).ThenBy(g => g.Key, StringComparer.Ordinal)
                .ToList();
}
