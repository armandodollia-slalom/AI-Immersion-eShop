using AgentOps.Data.Reporting;
using Microsoft.AspNetCore.Http.HttpResults;

namespace AgentOps.API;

/// <summary>Read-only endpoints over agentopsdb. Writes happen only through the AgentOps CLI ingest job.</summary>
public static class AgentOpsApi
{
    public static RouteGroupBuilder MapAgentOpsApiV1(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/agentops").HasApiVersion(1.0);

        api.MapGet("/summary", GetSummary);
        api.MapGet("/prs", ListPullRequests);
        api.MapGet("/prs/{number:int}", GetPullRequest);
        api.MapGet("/mistakes", ListMistakes);

        return api;
    }

    public static async Task<Ok<RollupReport>> GetSummary(AgentOpsReports reports, CancellationToken ct, int days = 30) =>
        TypedResults.Ok(await reports.GetRollupAsync(days, ct));

    public static async Task<Ok<List<PrListItem>>> ListPullRequests(AgentOpsReports reports, CancellationToken ct, int take = 50) =>
        TypedResults.Ok(await reports.ListPullRequestsAsync(take, ct));

    public static async Task<Results<Ok<PrReport>, NotFound>> GetPullRequest(int number, AgentOpsReports reports, CancellationToken ct) =>
        await reports.GetPrReportAsync(number, ct) is { } report ? TypedResults.Ok(report) : TypedResults.NotFound();

    public static async Task<Ok<List<MistakeRow>>> ListMistakes(AgentOpsReports reports, CancellationToken ct, string? agent = null, int days = 30, int take = 200) =>
        TypedResults.Ok(await reports.ListMistakesAsync(agent, days, take, ct));
}
