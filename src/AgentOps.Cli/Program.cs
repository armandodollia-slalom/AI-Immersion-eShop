using System.Diagnostics;
using System.Text.Json;
using AgentOps.Data;
using AgentOps.Data.Events;
using AgentOps.Data.Ingestion;
using AgentOps.Data.Reporting;
using Microsoft.EntityFrameworkCore;

// AgentOps CLI, used by the .github/workflows/agentops-*.yml jobs (see docs/ai-pipeline/agentops.md).
//   collect --event <github event json> --out <batch.json> [--repo <dir>] [--policy-review <response.json>]
//   ingest  --batch <batch.json>
//   report  pr --number <n> | rollup [--days <n>]   [--format md|json] [--out <file>]
// ingest and report read the connection string from ConnectionStrings__agentopsdb.

var command = args.FirstOrDefault();
var options = ParseOptions(args.Skip(1));
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

try
{
    return command switch
    {
        "collect" => await CollectAsync(options, cts.Token),
        "ingest" => await IngestAsync(options, cts.Token),
        "report" => await ReportAsync(args.ElementAtOrDefault(1), ParseOptions(args.Skip(2)), cts.Token),
        _ => Usage(),
    };
}
catch (Exception ex) when (ex is InvalidDataException or ArgumentException or InvalidOperationException or JsonException or FormatException or IOException)
{
    await Console.Error.WriteLineAsync($"agentops {command}: {ex.Message}");
    return 1;
}

static async Task<int> CollectAsync(Dictionary<string, string> options, CancellationToken ct)
{
    var pr = ReadPullRequest(Required(options, "event"));
    var repo = options.GetValueOrDefault("repo", ".");
    var diff = await GitAsync(repo, ct, "diff", "--unified=0", "--no-color", "--no-ext-diff", $"{pr.BaseSha}...{pr.HeadSha}", "--", MetricsDiffParser.MetricsDirectory);
    var added = MetricsDiffParser.AddedLines(diff);

    JsonElement? policy = null;
    if (options.TryGetValue("policy-review", out var policyFile) && File.Exists(policyFile))
    {
        try
        {
            using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(policyFile, ct));
            policy = doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            await Console.Error.WriteLineAsync($"agentops collect: ignoring unparsable policy review ({ex.Message})");
        }
    }

    var batch = BatchCollector.Build(pr, added, policy, DateTimeOffset.UtcNow);
    await File.WriteAllTextAsync(Required(options, "out"), JsonSerializer.Serialize(batch, AgentEventBatch.JsonOptions), ct);
    Console.WriteLine($"PR #{pr.Number}: {batch.Reviews.Count} review run(s), {batch.Mistakes.Count} mistake(s), {batch.Skipped} skipped record(s).");
    return 0;
}

static async Task<int> IngestAsync(Dictionary<string, string> options, CancellationToken ct)
{
    var batch = JsonSerializer.Deserialize<AgentEventBatch>(await File.ReadAllTextAsync(Required(options, "batch"), ct), AgentEventBatch.JsonOptions)
        ?? throw new InvalidDataException("The batch file is empty.");
    await using var db = CreateContext();
    await db.Database.MigrateAsync(ct);
    var result = await new BatchIngester(db, TimeProvider.System).IngestAsync(batch, ct);
    Console.WriteLine($"PR #{result.PullRequestNumber}: inserted {result.ReviewsInserted} review run(s) and {result.MistakesInserted} mistake(s); skipped {result.Skipped}.");
    return 0;
}

static async Task<int> ReportAsync(string? kind, Dictionary<string, string> options, CancellationToken ct)
{
    await using var db = CreateContext();
    var reports = new AgentOpsReports(db, TimeProvider.System);
    var json = options.GetValueOrDefault("format") == "json";
    string output;
    switch (kind)
    {
        case "pr":
            var number = int.Parse(Required(options, "number"), System.Globalization.CultureInfo.InvariantCulture);
            var pr = await reports.GetPrReportAsync(number, ct) ?? new PrReport(number, "", "", "", []);
            output = json ? JsonSerializer.Serialize(pr, AgentEventBatch.JsonOptions) : MarkdownReport.RenderPr(pr);
            break;
        case "rollup":
            var days = int.Parse(options.GetValueOrDefault("days", "7"), System.Globalization.CultureInfo.InvariantCulture);
            var rollup = await reports.GetRollupAsync(days, ct);
            output = json ? JsonSerializer.Serialize(rollup, AgentEventBatch.JsonOptions) : MarkdownReport.RenderRollup(rollup);
            break;
        default:
            return Usage();
    }

    if (options.TryGetValue("out", out var file))
    {
        await File.WriteAllTextAsync(file, output, ct);
    }
    else
    {
        Console.WriteLine(output);
    }

    return 0;
}

static AgentOpsContext CreateContext()
{
    var connection = Environment.GetEnvironmentVariable($"ConnectionStrings__{AgentOpsContext.ConnectionName}");
    if (string.IsNullOrWhiteSpace(connection))
    {
        throw new InvalidOperationException($"Set ConnectionStrings__{AgentOpsContext.ConnectionName} to the agentopsdb connection string.");
    }

    return new AgentOpsContext(new DbContextOptionsBuilder<AgentOpsContext>()
        .UseNpgsql(connection, npgsql => npgsql.EnableRetryOnFailure())
        .Options);
}

static PullRequestInfo ReadPullRequest(string eventFile)
{
    using var doc = JsonDocument.Parse(File.ReadAllText(eventFile));
    if (!doc.RootElement.TryGetProperty("pull_request", out var pr))
    {
        throw new InvalidDataException("The event payload has no pull_request; run collect from a pull_request workflow.");
    }

    static string Str(JsonElement e, params string[] path)
    {
        foreach (var name in path)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out e))
            {
                return "";
            }
        }

        return e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : "";
    }

    var labels = pr.TryGetProperty("labels", out var l) && l.ValueKind == JsonValueKind.Array
        ? l.EnumerateArray().Select(x => Str(x, "name")).Where(n => n.Length > 0).ToList()
        : [];
    return new PullRequestInfo
    {
        Number = pr.GetProperty("number").GetInt32(),
        Title = Str(pr, "title"),
        Author = Str(pr, "user", "login"),
        Url = Str(pr, "html_url"),
        HeadSha = Str(pr, "head", "sha"),
        BaseSha = Str(pr, "base", "sha"),
        Labels = labels,
    };
}

static async Task<string> GitAsync(string repo, CancellationToken ct, params string[] args)
{
    var psi = new ProcessStartInfo("git") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
    psi.ArgumentList.Add("-C");
    psi.ArgumentList.Add(repo);
    foreach (var a in args)
    {
        psi.ArgumentList.Add(a);
    }

    using var process = Process.Start(psi) ?? throw new InvalidOperationException("Could not start git.");
    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
    timeout.CancelAfter(GitTimeout);
    try
    {
        var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
        await process.WaitForExitAsync(timeout.Token);
        return process.ExitCode == 0 ? await stdout : throw new InvalidOperationException($"git {args[0]} failed: {(await stderr).Trim()}");
    }
    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
    {
        process.Kill(entireProcessTree: true);
        throw new InvalidOperationException($"git {args[0]} timed out after {GitTimeout.TotalSeconds:0}s.");
    }
}

static Dictionary<string, string> ParseOptions(IEnumerable<string> args)
{
    var result = new Dictionary<string, string>(StringComparer.Ordinal);
    string? key = null;
    foreach (var arg in args)
    {
        if (arg.StartsWith("--", StringComparison.Ordinal))
        {
            key = arg[2..];
            result[key] = "";
        }
        else if (key is not null)
        {
            result[key] = arg;
            key = null;
        }
    }

    return result;
}

static string Required(Dictionary<string, string> options, string name) =>
    options.TryGetValue(name, out var value) && value.Length > 0 ? value : throw new ArgumentException($"--{name} is required.");

static int Usage()
{
    Console.Error.WriteLine("usage: agentops collect --event <file> --out <file> [--repo <dir>] [--policy-review <file>]");
    Console.Error.WriteLine("       agentops ingest --batch <file>");
    Console.Error.WriteLine("       agentops report pr --number <n> | rollup [--days <n>]  [--format md|json] [--out <file>]");
    return 2;
}

internal static partial class Program
{
    private static readonly TimeSpan GitTimeout = TimeSpan.FromMinutes(2);
}
