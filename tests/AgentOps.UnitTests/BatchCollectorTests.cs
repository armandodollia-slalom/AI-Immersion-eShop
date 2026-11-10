using System.Text.Json;
using AgentOps.Data.Events;

namespace AgentOps.UnitTests;

[TestClass]
public class BatchCollectorTests
{
    private static readonly DateTimeOffset Now = new(2026, 5, 1, 12, 0, 0, TimeSpan.Zero);

    private static PullRequestInfo Pr(params string[] labels) =>
        new() { Number = 42, Title = "PROMO-3", HeadSha = "abc", BaseSha = "def", Labels = [.. labels] };

    private static Dictionary<string, List<string>> Lines(string file, params string[] lines) => new() { [file] = [.. lines] };

    [TestMethod]
    public void DiffParserKeepsOnlyLinesAddedToMetricsFiles()
    {
        const string diff = """
            diff --git a/.agent-metrics/arch-reviews.jsonl b/.agent-metrics/arch-reviews.jsonl
            --- a/.agent-metrics/arch-reviews.jsonl
            +++ b/.agent-metrics/arch-reviews.jsonl
            @@ -1,0 +2,2 @@
            +{"a":1}
            -{"removed":true}
            +{"a":2}
            diff --git a/src/Foo.cs b/src/Foo.cs
            --- a/src/Foo.cs
            +++ b/src/Foo.cs
            @@ -1 +1 @@
            +var x = 1;
            """;

        var added = MetricsDiffParser.AddedLines(diff);

        Assert.HasCount(1, added);
        CollectionAssert.AreEqual(new[] { "{\"a\":1}", "{\"a\":2}" }, added["arch-reviews.jsonl"]);
    }

    [TestMethod]
    public void PolicyGateReviewIsAttributedToImplementerWithRuleKeys()
    {
        var line = """{"ts":"2026-04-30T10:00:00Z","story":"PROMO-3","round":1,"verdict":"CHANGES_REQUESTED","reviewer":"arch-review-agent","findings":[{"severity":"blocking","category":"data","file":"src/A.cs","rule":"DATA-004"}]}""";

        var batch = BatchCollector.Build(Pr(), Lines(BatchCollector.ArchReviews, line), null, Now);

        var review = batch.Reviews.Single();
        var mistake = batch.Mistakes.Single();
        Assert.AreEqual(PipelineAgents.Implementer, review.Agent);
        Assert.AreEqual("arch-review-agent", review.Source);
        Assert.IsFalse(review.Passed);
        Assert.AreEqual(new DateTimeOffset(2026, 4, 30, 10, 0, 0, TimeSpan.Zero), review.OccurredAt);
        Assert.AreEqual("DATA-004", mistake.Key);
        Assert.AreEqual(review.EventId, mistake.ReviewEventId);
    }

    [TestMethod]
    public void VerifierDenialLinksToItsRunAndUsesAttributedAgent()
    {
        var lines = new Dictionary<string, List<string>>
        {
            [BatchCollector.VerifierRuns] = ["""{"ts":"t1","stage":"automation","story":"S-1","round":2,"score":6,"passed":false,"gaps":1}"""],
            [BatchCollector.VerifierDenials] = ["""{"ts":"t1","stage":"automation","story":"S-1","round":2,"category":"coverage","subtype":"missing-case","case":"TC-3","detail":"not tested","root_stage":"plan","attributed_agent":"qe-plan"}"""],
        };

        var batch = BatchCollector.Build(Pr(), lines, null, Now);

        var run = batch.Reviews.Single();
        var gap = batch.Mistakes.Single();
        Assert.AreEqual(PipelineAgents.QeAutomation, run.Agent);
        Assert.AreEqual(6, run.Score);
        Assert.AreEqual(PipelineAgents.QePlan, gap.Agent);
        Assert.AreEqual("coverage/missing-case", gap.Key);
        Assert.AreEqual(run.EventId, gap.ReviewEventId);
        Assert.AreEqual("[TC-3] not tested", gap.Message);
    }

    [TestMethod]
    public void RecordsForNonPipelineAgentsAndBadLinesAreSkipped()
    {
        var lines = new Dictionary<string, List<string>>
        {
            [BatchCollector.VerifierDenials] = ["""{"stage":"plan","category":"x","attributed_agent":"none"}""", "not json"],
            ["calibration.jsonl"] = ["""{"stage":"plan"}"""],
        };

        var batch = BatchCollector.Build(Pr(), lines, null, Now);

        Assert.IsEmpty(batch.Reviews);
        Assert.IsEmpty(batch.Mistakes);
        Assert.AreEqual(3, batch.Skipped);
    }

    [TestMethod]
    public void EventIdsAreDeterministicSoReCollectingIsIdempotent()
    {
        var line = """{"ts":"t","stage":"plan","story":"S","round":1,"errors":["missing case file"]}""";

        var first = BatchCollector.Build(Pr(), Lines(BatchCollector.PrecheckFailures, line), null, Now);
        var second = BatchCollector.Build(Pr(), Lines(BatchCollector.PrecheckFailures, line), null, Now.AddHours(1));

        Assert.AreEqual(first.BatchId, second.BatchId);
        CollectionAssert.AreEqual(first.Mistakes.Select(m => m.EventId).ToList(), second.Mistakes.Select(m => m.EventId).ToList());
        Assert.AreEqual(PipelineAgents.QePlan, first.Mistakes.Single().Agent);
    }

    [TestMethod]
    public void FinalPolicyReviewUsesAgentLabelAndCountsOnlyFailedItems()
    {
        using var doc = JsonDocument.Parse("""
            {"decision":"BLOCK","action_items":[
              {"finding_id":"f1","rule_id":"SEC-001","rule_title":"No secrets","category":"security","outcome":"BLOCK","status":"fail","file":"a.json","line":3,"message":"password"},
              {"finding_id":"f2","rule_id":"API-003","outcome":"WARN","status":"needs_review"},
              {"finding_id":"f4","rule_id":"ARCH-005","outcome":"WARN","status":"missing_evidence"},
              {"finding_id":"f3","rule_id":"OBS-003","outcome":"ADVISORY","status":"fail"}]}
            """);

        var batch = BatchCollector.Build(Pr("agent:qe-automation"), new Dictionary<string, List<string>>(), doc.RootElement, Now);

        var review = batch.Reviews.Single();
        var mistake = batch.Mistakes.Single();
        Assert.AreEqual(BatchCollector.PolicyFinalSource, review.Source);
        Assert.AreEqual(PipelineAgents.QeAutomation, review.Agent);
        Assert.IsFalse(review.Passed);
        Assert.AreEqual("SEC-001", mistake.Key);
        Assert.AreEqual("blocking", mistake.Severity);
        Assert.AreEqual(3, mistake.Line);
    }

    [TestMethod]
    public void FinalPolicyReviewIsSkippedWhenNoPipelineAgentWorkedOnThePr()
    {
        using var doc = JsonDocument.Parse("""{"decision":"PASS","action_items":[]}""");

        var batch = BatchCollector.Build(Pr("agent:someone-else"), new Dictionary<string, List<string>>(), doc.RootElement, Now);

        Assert.IsEmpty(batch.Reviews);
        Assert.AreEqual(1, batch.Skipped);
    }
}
