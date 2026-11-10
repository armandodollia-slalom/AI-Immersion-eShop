using AgentOps.Data.Events;
using AgentOps.Data.Reporting;

namespace AgentOps.UnitTests;

[TestClass]
public class ReportTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 1, 0, 0, 0, TimeSpan.Zero);

    private static ReviewRow Review(int pr, string agent, int round, bool passed, string source = "arch-review-agent") =>
        new(pr, agent, source, "S", "review", round, passed ? "APPROVED" : "CHANGES_REQUESTED", passed, null, T0.AddHours(round));

    private static MistakeRow Mistake(int pr, string agent, string key, string severity = "blocking", string? file = "src/A.cs", string source = "arch-review-agent") =>
        new(pr, agent, source, key, "data", key, severity, file, null, "msg", "review", 1, T0);

    [TestMethod]
    public void RollupComputesFirstPassRateRoundsAndRepeatMistakes()
    {
        var reviews = new[]
        {
            Review(1, PipelineAgents.Implementer, 1, false), Review(1, PipelineAgents.Implementer, 2, false), Review(1, PipelineAgents.Implementer, 3, true),
            Review(2, PipelineAgents.Implementer, 1, true),
            Review(2, PipelineAgents.Implementer, 1, false, source: "precheck"),
        };
        var mistakes = new[]
        {
            Mistake(1, PipelineAgents.Implementer, "DATA-004"),
            Mistake(2, PipelineAgents.Implementer, "DATA-004", source: BatchCollector.PolicyFinalSource),
            Mistake(2, PipelineAgents.Implementer, "OBS-002", severity: "minor", file: "src/B.cs"),
        };

        var rollup = ReportBuilder.BuildRollup(T0, T0.AddDays(7), reviews, mistakes);

        var implementer = rollup.Agents.Single();
        Assert.AreEqual(2, implementer.PullRequests);
        Assert.AreEqual(0.5, implementer.FirstPassRate);
        Assert.AreEqual(2.0, implementer.AverageRoundsToApproval);
        Assert.AreEqual(3, implementer.Mistakes);
        Assert.AreEqual(2, implementer.BlockingMistakes);
        Assert.AreEqual(1, implementer.EscapedMistakes);
        var repeat = rollup.RepeatMistakes.Single();
        Assert.AreEqual("DATA-004", repeat.Key);
        Assert.AreEqual(2, repeat.PullRequests);
        Assert.AreEqual("src/A.cs", rollup.Hotspots[0].File);
    }

    [TestMethod]
    public void PrReportFlagsMistakesSeenInOtherPrs()
    {
        var report = ReportBuilder.BuildPrReport(
            5, "t", "u", "a",
            [Review(5, PipelineAgents.Implementer, 1, true)],
            [Mistake(5, PipelineAgents.Implementer, "DATA-004"), Mistake(5, PipelineAgents.Implementer, "ARCH-006")],
            new Dictionary<(string, string), int> { [(PipelineAgents.Implementer, "DATA-004")] = 3 });

        var groups = report.Agents.Single().MistakeGroups.ToDictionary(g => g.Key);
        Assert.AreEqual(3, groups["DATA-004"].PriorPullRequests);
        Assert.AreEqual(0, groups["ARCH-006"].PriorPullRequests);

        var markdown = MarkdownReport.RenderPr(report);
        Assert.StartsWith(MarkdownReport.PrCommentMarker, markdown);
        Assert.Contains("**3** (repeat)", markdown);
    }

    [TestMethod]
    public void MarkdownEscapesPrSourcedText()
    {
        var cell = MarkdownReport.Cell("a|b <script> @team\nnext `x`");

        Assert.AreEqual("a\\|b &lt;script&gt; @\u200Bteam next 'x'", cell);
    }
}
