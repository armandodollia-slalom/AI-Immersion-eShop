namespace AgentOps.Data.Events;

/// <summary>The agents AgentOps tracks. Events attributed to anything else are dropped.</summary>
public static class PipelineAgents
{
    public const string Implementer = "implementer";
    public const string QePlan = "qe-plan";
    public const string QeAutomation = "qe-automation";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal) { Implementer, QePlan, QeAutomation };

    public static bool IsPipelineAgent(string? name) => name is not null && All.Contains(name);

    /// <summary>The agent that produced the work a QE stage reviews (mirrors scripts/qe/lib/verify.mjs PRODUCER).</summary>
    public static string? ProducerOf(string? stage) => stage switch
    {
        "plan" => QePlan,
        "automation" => QeAutomation,
        _ => null,
    };

    public static string VerifierOf(string? stage) => stage switch
    {
        "plan" => "qe-plan-verifier",
        "automation" => "qe-automation-verifier",
        _ => "verifier",
    };
}
