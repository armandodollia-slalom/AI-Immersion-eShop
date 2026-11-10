using AgentOps.Data.Events;
using AgentOps.Data.Ingestion;

namespace AgentOps.UnitTests;

[TestClass]
public class IngestionTests
{
    private static readonly string IdA = new('a', 64);
    private static readonly string IdB = new('b', 64);

    private static AgentEventBatch Batch(params MistakeEvent[] mistakes) => new()
    {
        BatchId = new string('c', 64),
        PullRequest = new PullRequestInfo { Number = 7, Title = "t" },
        Mistakes = [.. mistakes],
    };

    private static MistakeEvent Mistake(string id, string agent = PipelineAgents.Implementer) =>
        new() { EventId = id, Agent = agent, Source = "s", Category = "fit" };

    [TestMethod]
    public void PlannerSkipsStoredAndRepeatedEvents()
    {
        var batch = Batch(Mistake(IdA), Mistake(IdA), Mistake(IdB));

        var plan = IngestPlanner.Plan(batch, new HashSet<string>(), new HashSet<string> { IdB });

        Assert.AreEqual(IdA, plan.Mistakes.Single().EventId);
        Assert.AreEqual(2, plan.Duplicates);
    }

    [TestMethod]
    public void SanitizerRejectsUnknownSchemaAndMissingPrNumber()
    {
        Assert.ThrowsExactly<InvalidDataException>(() => BatchSanitizer.Sanitize(Batch() with { Schema = "other/v9" }));
        Assert.ThrowsExactly<InvalidDataException>(() => BatchSanitizer.Sanitize(Batch() with { PullRequest = new PullRequestInfo() }));
        Assert.ThrowsExactly<InvalidDataException>(() => BatchSanitizer.Sanitize(Batch() with { BatchId = "../etc" }));
    }

    [TestMethod]
    public void SanitizerDropsNonPipelineAgentsAndForgedIdsAndTruncatesText()
    {
        var batch = Batch(
            Mistake(IdA) with { Message = new string('x', 5000), File = "a\u0000b.cs" },
            Mistake(IdB, agent: "attacker"),
            Mistake("not-a-hash"));

        var clean = BatchSanitizer.Sanitize(batch);

        var kept = clean.Mistakes.Single();
        Assert.AreEqual(IdA, kept.EventId);
        Assert.AreEqual(Data.Limits.Message, kept.Message!.Length);
        Assert.AreEqual("ab.cs", kept.File);
        Assert.AreEqual(2, clean.Skipped);
    }
}
