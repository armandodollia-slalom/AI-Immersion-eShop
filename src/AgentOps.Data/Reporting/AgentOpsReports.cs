using AgentOps.Data.Model;
using Microsoft.EntityFrameworkCore;

namespace AgentOps.Data.Reporting;

/// <summary>Loads report data from agentopsdb (read-only, no tracking) and hands it to <see cref="ReportBuilder"/>.</summary>
public sealed class AgentOpsReports(AgentOpsContext db, TimeProvider time)
{
    public async Task<PrReport?> GetPrReportAsync(int number, CancellationToken ct)
    {
        var pr = await db.PullRequests.AsNoTracking().SingleOrDefaultAsync(p => p.Number == number, ct);
        if (pr is null)
        {
            return null;
        }

        var reviews = await ReviewRows(db.ReviewRuns.Where(r => r.PullRequestId == pr.Id)).ToListAsync(ct);
        var mistakes = await MistakeRows(db.Mistakes.Where(m => m.PullRequestId == pr.Id)).ToListAsync(ct);

        var keys = mistakes.Select(m => m.Key).Distinct().ToList();
        var prior = await db.Mistakes.AsNoTracking()
            .Where(m => m.PullRequestId != pr.Id && keys.Contains(m.MistakeKey))
            .Select(m => new { Agent = m.Agent!.Name, m.MistakeKey, m.PullRequestId })
            .Distinct()
            .ToListAsync(ct);
        var priorCounts = prior.GroupBy(p => (p.Agent, p.MistakeKey)).ToDictionary(g => g.Key, g => g.Count());

        return ReportBuilder.BuildPrReport(pr.Number, pr.Title, pr.Url, pr.Author, reviews, mistakes, priorCounts);
    }

    public async Task<RollupReport> GetRollupAsync(int days, CancellationToken ct)
    {
        var to = time.GetUtcNow();
        var from = to.AddDays(-Math.Clamp(days, 1, 365));
        var reviews = await ReviewRows(db.ReviewRuns.Where(r => r.OccurredAt >= from)).ToListAsync(ct);
        var mistakes = await MistakeRows(db.Mistakes.Where(m => m.OccurredAt >= from)).ToListAsync(ct);
        return ReportBuilder.BuildRollup(from, to, reviews, mistakes);
    }

    public Task<List<PrListItem>> ListPullRequestsAsync(int take, CancellationToken ct) =>
        db.PullRequests.AsNoTracking()
            .OrderByDescending(p => p.LastIngestedAt)
            .Take(Math.Clamp(take, 1, 200))
            .Select(p => new PrListItem(
                p.Number, p.Title, p.Author, p.Url,
                db.ReviewRuns.Count(r => r.PullRequestId == p.Id),
                db.Mistakes.Count(m => m.PullRequestId == p.Id),
                p.LastIngestedAt))
            .ToListAsync(ct);

    public Task<List<MistakeRow>> ListMistakesAsync(string? agent, int days, int take, CancellationToken ct)
    {
        var from = time.GetUtcNow().AddDays(-Math.Clamp(days, 1, 365));
        var query = db.Mistakes.Where(m => m.OccurredAt >= from);
        if (!string.IsNullOrWhiteSpace(agent))
        {
            query = query.Where(m => m.Agent!.Name == agent);
        }

        return MistakeRows(query.OrderByDescending(m => m.OccurredAt).Take(Math.Clamp(take, 1, 500))).ToListAsync(ct);
    }

    private static IQueryable<ReviewRow> ReviewRows(IQueryable<ReviewRun> runs) =>
        runs.AsNoTracking().Select(r => new ReviewRow(
            r.PullRequest!.Number, r.Agent!.Name, r.Source, r.Story, r.Stage, r.Round, r.Verdict, r.Passed, r.Score, r.OccurredAt));

    private static IQueryable<MistakeRow> MistakeRows(IQueryable<Mistake> mistakes) =>
        mistakes.AsNoTracking().Select(m => new MistakeRow(
            m.PullRequest!.Number, m.Agent!.Name, m.Source, m.MistakeKey, m.Category, m.Rule, m.Severity,
            m.File, m.Line, m.Message, m.Stage, m.Round, m.OccurredAt));
}
