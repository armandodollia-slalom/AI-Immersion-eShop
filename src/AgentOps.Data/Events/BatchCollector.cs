using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AgentOps.Data.Events;

/// <summary>
/// Turns the raw records a PR added to .agent-metrics/*.jsonl, plus the optional final policy review of the PR,
/// into one <see cref="AgentEventBatch"/>. Only pipeline agents are kept; everything else is counted as skipped.
/// </summary>
public static class BatchCollector
{
    public const string ArchReviews = "arch-reviews.jsonl";
    public const string VerifierRuns = "verifier-runs.jsonl";
    public const string VerifierDenials = "verifier-denials.jsonl";
    public const string PrecheckFailures = "precheck-failures.jsonl";
    public const string PolicyFinalSource = "policy-final";
    public const string AgentLabelPrefix = "agent:";

    public static AgentEventBatch Build(
        PullRequestInfo pr,
        IReadOnlyDictionary<string, List<string>> addedMetricLines,
        JsonElement? policyReview,
        DateTimeOffset collectedAt)
    {
        var reviews = new List<ReviewEvent>();
        var mistakes = new List<MistakeEvent>();
        var skipped = 0;

        foreach (var (file, lines) in addedMetricLines.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            foreach (var line in lines)
            {
                if (!TryParse(line, out var record))
                {
                    skipped++;
                    continue;
                }

                var handled = file switch
                {
                    ArchReviews => AddArchReview(line, record, collectedAt, reviews, mistakes),
                    VerifierRuns => AddVerifierRun(record, collectedAt, reviews),
                    VerifierDenials => AddVerifierDenial(line, record, collectedAt, mistakes),
                    PrecheckFailures => AddPrecheck(line, record, collectedAt, reviews, mistakes),
                    _ => false,
                };
                if (!handled)
                {
                    skipped++;
                }
            }
        }

        if (policyReview is { ValueKind: JsonValueKind.Object } response)
        {
            var agent = AgentFromLabels(pr.Labels) ?? (reviews.Any(r => r.Agent == PipelineAgents.Implementer) ? PipelineAgents.Implementer : null);
            if (agent is null)
            {
                skipped++;
            }
            else
            {
                AddPolicyReview(pr, agent, response, collectedAt, reviews, mistakes);
            }
        }

        return new AgentEventBatch
        {
            BatchId = EventId("batch", pr.Number.ToString(CultureInfo.InvariantCulture), pr.HeadSha),
            CollectedAt = collectedAt,
            PullRequest = pr,
            Reviews = reviews,
            Mistakes = mistakes,
            Skipped = skipped,
        };
    }

    public static string? AgentFromLabels(IEnumerable<string> labels) =>
        labels.Where(l => l.StartsWith(AgentLabelPrefix, StringComparison.OrdinalIgnoreCase))
              .Select(l => l[AgentLabelPrefix.Length..].Trim().ToLowerInvariant())
              .FirstOrDefault(PipelineAgents.IsPipelineAgent);

    // Architecture reviews (LLM reviewer and the policy-pack gate) review the implementer's code.
    private static bool AddArchReview(string line, JsonElement r, DateTimeOffset now, List<ReviewEvent> reviews, List<MistakeEvent> mistakes)
    {
        var verdict = Str(r, "verdict");
        if (verdict is null)
        {
            return false;
        }

        var source = Str(r, "reviewer") ?? "architecture-reviewer";
        var reviewId = EventId(ArchReviews, line);
        var common = (Story: Str(r, "story"), Round: Int(r, "round"), At: Ts(r, now));
        reviews.Add(new ReviewEvent
        {
            EventId = reviewId,
            Agent = PipelineAgents.Implementer,
            Source = source,
            Story = common.Story,
            Stage = "review",
            Round = common.Round,
            Verdict = verdict,
            Passed = verdict == "APPROVED",
            OccurredAt = common.At,
        });

        var index = 0;
        foreach (var f in Array(r, "findings"))
        {
            mistakes.Add(new MistakeEvent
            {
                EventId = EventId(reviewId, index++.ToString(CultureInfo.InvariantCulture)),
                ReviewEventId = reviewId,
                Agent = PipelineAgents.Implementer,
                Source = source,
                Category = Str(f, "category") ?? "other",
                Rule = Str(f, "rule"),
                Severity = Str(f, "severity"),
                File = Str(f, "file"),
                Story = common.Story,
                Stage = "review",
                Round = common.Round,
                OccurredAt = common.At,
            });
        }

        return true;
    }

    private static bool AddVerifierRun(JsonElement r, DateTimeOffset now, List<ReviewEvent> reviews)
    {
        var stage = Str(r, "stage");
        var agent = PipelineAgents.ProducerOf(stage);
        if (agent is null)
        {
            return false;
        }

        var passed = r.TryGetProperty("passed", out var p) && p.ValueKind == JsonValueKind.True;
        reviews.Add(new ReviewEvent
        {
            EventId = VerifierRunId(r),
            Agent = agent,
            Source = PipelineAgents.VerifierOf(stage),
            Story = Str(r, "story"),
            Stage = stage,
            Round = Int(r, "round"),
            Verdict = passed ? "PASSED" : "FAILED",
            Passed = passed,
            Score = Int(r, "score"),
            OccurredAt = Ts(r, now),
        });
        return true;
    }

    // A denial and its verifier run share ts/stage/story/round, so the denial links to the run's event id.
    private static bool AddVerifierDenial(string line, JsonElement r, DateTimeOffset now, List<MistakeEvent> mistakes)
    {
        var agent = Str(r, "attributed_agent");
        if (!PipelineAgents.IsPipelineAgent(agent))
        {
            return false;
        }

        var stage = Str(r, "stage");
        var @case = Str(r, "case");
        var detail = Str(r, "detail");
        mistakes.Add(new MistakeEvent
        {
            EventId = EventId(VerifierDenials, line),
            ReviewEventId = VerifierRunId(r),
            Agent = agent!,
            Source = PipelineAgents.VerifierOf(stage),
            Category = Str(r, "category") ?? "other",
            Subtype = Str(r, "subtype"),
            File = Str(r, "location"),
            Message = @case is null ? detail : $"[{@case}] {detail}",
            Story = Str(r, "story"),
            Stage = stage,
            Round = Int(r, "round"),
            OccurredAt = Ts(r, now),
        });
        return true;
    }

    private static bool AddPrecheck(string line, JsonElement r, DateTimeOffset now, List<ReviewEvent> reviews, List<MistakeEvent> mistakes)
    {
        var stage = Str(r, "stage");
        var agent = PipelineAgents.ProducerOf(stage);
        if (agent is null)
        {
            return false;
        }

        var reviewId = EventId(PrecheckFailures, line);
        var common = (Story: Str(r, "story"), Round: Int(r, "round"), At: Ts(r, now));
        reviews.Add(new ReviewEvent
        {
            EventId = reviewId,
            Agent = agent,
            Source = "precheck",
            Story = common.Story,
            Stage = stage,
            Round = common.Round,
            Verdict = "FAILED",
            Passed = false,
            OccurredAt = common.At,
        });

        var index = 0;
        foreach (var error in Array(r, "errors"))
        {
            mistakes.Add(new MistakeEvent
            {
                EventId = EventId(reviewId, index++.ToString(CultureInfo.InvariantCulture)),
                ReviewEventId = reviewId,
                Agent = agent,
                Source = "precheck",
                Category = "precheck",
                Severity = "blocking",
                Message = error.ValueKind == JsonValueKind.String ? error.GetString() : error.GetRawText(),
                Story = common.Story,
                Stage = stage,
                Round = common.Round,
                OccurredAt = common.At,
            });
        }

        return true;
    }

    // The policy pack run by CI on the final PR diff: mistakes that escaped the in-loop review.
    private static void AddPolicyReview(PullRequestInfo pr, string agent, JsonElement response, DateTimeOffset now, List<ReviewEvent> reviews, List<MistakeEvent> mistakes)
    {
        var decision = Str(response, "decision") ?? "ERROR";
        var number = pr.Number.ToString(CultureInfo.InvariantCulture);
        var reviewId = EventId(PolicyFinalSource, number, pr.HeadSha);
        reviews.Add(new ReviewEvent
        {
            EventId = reviewId,
            Agent = agent,
            Source = PolicyFinalSource,
            Stage = "pr",
            Verdict = decision,
            Passed = decision is "PASS" or "WARN",
            OccurredAt = now,
        });

        var index = 0;
        foreach (var item in Array(response, "action_items"))
        {
            var outcome = Str(item, "outcome");
            // Only real violations count; needs_review, missing_evidence (process sign-off) and error (validator crash) are not agent mistakes.
            if (outcome is not ("BLOCK" or "WARN") || Str(item, "status") != "fail")
            {
                continue;
            }

            var title = Str(item, "rule_title");
            var message = Str(item, "message");
            mistakes.Add(new MistakeEvent
            {
                EventId = EventId(PolicyFinalSource, number, pr.HeadSha, Str(item, "finding_id") ?? index.ToString(CultureInfo.InvariantCulture)),
                ReviewEventId = reviewId,
                Agent = agent,
                Source = PolicyFinalSource,
                Category = Str(item, "category") ?? "other",
                Rule = Str(item, "rule_id"),
                Severity = outcome == "BLOCK" ? "blocking" : "warning",
                File = Str(item, "file"),
                Line = Int(item, "line"),
                Message = title is null ? message : $"{title}: {message}",
                Stage = "pr",
                OccurredAt = now,
            });
            index++;
        }
    }

    private static string VerifierRunId(JsonElement r) =>
        EventId("verifier-run", Str(r, "stage") ?? "", Str(r, "story") ?? "", Int(r, "round")?.ToString(CultureInfo.InvariantCulture) ?? "", Str(r, "ts") ?? "");

    public static string EventId(params string[] parts)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\u001f', parts)));
        return Convert.ToHexStringLower(bytes);
    }

    private static bool TryParse(string line, out JsonElement record)
    {
        record = default;
        if (string.IsNullOrWhiteSpace(line))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(line);
            record = doc.RootElement.Clone();
            return record.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString())
            ? v.GetString()
            : null;

    private static int? Int(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    private static DateTimeOffset Ts(JsonElement e, DateTimeOffset fallback) =>
        DateTimeOffset.TryParse(Str(e, "ts"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var ts) ? ts.ToUniversalTime() : fallback;

    private static IEnumerable<JsonElement> Array(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];
}
