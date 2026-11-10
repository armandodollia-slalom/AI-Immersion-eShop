using System.Globalization;
using System.Text;

namespace AgentOps.Data.Reporting;

/// <summary>Renders reports as GitHub Markdown. All text from the database is escaped: it originates from PR content.</summary>
public static class MarkdownReport
{
    public const string PrCommentMarker = "<!-- agentops-report -->";

    public static string RenderPr(PrReport report)
    {
        var sb = new StringBuilder();
        sb.AppendLine(PrCommentMarker);
        sb.AppendLine(CultureInfo.InvariantCulture, $"## AgentOps report for PR #{report.Number}");
        sb.AppendLine();
        if (report.Agents.Count == 0)
        {
            sb.AppendLine("No pipeline-agent review activity was recorded for this PR.");
            return sb.ToString();
        }

        sb.AppendLine("| Agent | Review runs | First-pass approvals | Avg rounds to approval | Mistakes | Blocking | Escaped to PR |");
        sb.AppendLine("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
        foreach (var a in report.Agents)
        {
            sb.AppendLine(CultureInfo.InvariantCulture,
                $"| {Cell(a.Agent)} | {a.ReviewRuns} | {a.FirstPassApproved}/{a.ReviewSeries} | {Number(a.AverageRoundsToApproval)} | {a.Mistakes} | {a.BlockingMistakes} | {a.EscapedMistakes} |");
        }

        foreach (var a in report.Agents.Where(a => a.MistakeGroups.Count > 0))
        {
            sb.AppendLine();
            sb.AppendLine(CultureInfo.InvariantCulture, $"### {Cell(a.Agent)}");
            sb.AppendLine();
            sb.AppendLine("| Mistake | Count | Severity | Where | Seen in other PRs | Example |");
            sb.AppendLine("| --- | ---: | --- | --- | ---: | --- |");
            foreach (var g in a.MistakeGroups.Take(15))
            {
                var repeat = g.PriorPullRequests > 0 ? $"**{g.PriorPullRequests}** (repeat)" : "0";
                sb.AppendLine(CultureInfo.InvariantCulture,
                    $"| {Code(g.Key)} | {g.Count} | {Cell(g.Severity)} | {string.Join("<br>", g.Files.Select(Code))} | {repeat} | {Cell(g.Example, 160)} |");
            }
        }

        sb.AppendLine();
        sb.AppendLine("<sub>Only pipeline agents (implementer, qe-plan, qe-automation) are tracked. \"Escaped to PR\" counts policy findings that survived the in-loop review. See docs/ai-pipeline/agentops.md.</sub>");
        return sb.ToString();
    }

    public static string RenderRollup(RollupReport report)
    {
        var sb = new StringBuilder();
        sb.AppendLine(CultureInfo.InvariantCulture, $"## AgentOps rollup {report.From:yyyy-MM-dd} to {report.To:yyyy-MM-dd}");
        sb.AppendLine();
        sb.AppendLine(CultureInfo.InvariantCulture, $"{report.PullRequests} pull request(s) with pipeline-agent activity.");
        sb.AppendLine();
        if (report.Agents.Count == 0)
        {
            return sb.ToString();
        }

        sb.AppendLine("| Agent | PRs | Review runs | First-pass rate | Avg rounds to approval | Mistakes | Blocking | Escaped to PR | Top mistakes |");
        sb.AppendLine("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
        foreach (var a in report.Agents)
        {
            var top = string.Join("<br>", a.TopMistakes.Select(g => $"{Code(g.Key)} x{g.Count}"));
            sb.AppendLine(CultureInfo.InvariantCulture,
                $"| {Cell(a.Agent)} | {a.PullRequests} | {a.ReviewRuns} | {Percent(a.FirstPassRate)} | {Number(a.AverageRoundsToApproval)} | {a.Mistakes} | {a.BlockingMistakes} | {a.EscapedMistakes} | {top} |");
        }

        if (report.RepeatMistakes.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("### Repeat mistakes");
            sb.AppendLine();
            sb.AppendLine("| Agent | Mistake | PRs | Occurrences | Last seen |");
            sb.AppendLine("| --- | --- | ---: | ---: | --- |");
            foreach (var r in report.RepeatMistakes)
            {
                sb.AppendLine(CultureInfo.InvariantCulture, $"| {Cell(r.Agent)} | {Code(r.Key)} | {r.PullRequests} | {r.Count} | {r.LastSeen:yyyy-MM-dd} |");
            }
        }

        if (report.Hotspots.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("### Hotspot files");
            sb.AppendLine();
            sb.AppendLine("| File | Mistakes | PRs |");
            sb.AppendLine("| --- | ---: | ---: |");
            foreach (var h in report.Hotspots)
            {
                sb.AppendLine(CultureInfo.InvariantCulture, $"| {Code(h.File)} | {h.Mistakes} | {h.PullRequests} |");
            }
        }

        return sb.ToString();
    }

    internal static string Cell(string? text, int max = 80)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return "";
        }

        var flat = string.Join(' ', text.Split(['\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (flat.Length > max)
        {
            flat = flat[..(max - 1)] + "…";
        }

        return flat.Replace("&", "&amp;", StringComparison.Ordinal)
                   .Replace("<", "&lt;", StringComparison.Ordinal)
                   .Replace(">", "&gt;", StringComparison.Ordinal)
                   .Replace("|", "\\|", StringComparison.Ordinal)
                   .Replace("`", "'", StringComparison.Ordinal)
                   .Replace("@", "@\u200B", StringComparison.Ordinal);
    }

    private static string Code(string? text) => string.IsNullOrWhiteSpace(text) ? "" : $"`{Cell(text)}`";

    private static string Number(double? value) => value?.ToString("0.##", CultureInfo.InvariantCulture) ?? "-";

    private static string Percent(double? value) => value is null ? "-" : (value.Value * 100).ToString("0", CultureInfo.InvariantCulture) + "%";
}
