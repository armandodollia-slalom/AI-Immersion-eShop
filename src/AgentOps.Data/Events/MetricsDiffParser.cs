namespace AgentOps.Data.Events;

/// <summary>Extracts the lines a PR added to .agent-metrics/*.jsonl from `git diff --unified=0` output.</summary>
public static class MetricsDiffParser
{
    public const string MetricsDirectory = ".agent-metrics/";

    public static Dictionary<string, List<string>> AddedLines(string diff)
    {
        var result = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        List<string>? current = null;
        foreach (var raw in diff.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.StartsWith("diff --git ", StringComparison.Ordinal))
            {
                current = null;
            }
            else if (line.StartsWith("+++ ", StringComparison.Ordinal))
            {
                var path = line[4..].Trim();
                path = path.StartsWith("b/", StringComparison.Ordinal) ? path[2..] : path;
                current = path.StartsWith(MetricsDirectory, StringComparison.Ordinal) && path.EndsWith(".jsonl", StringComparison.Ordinal)
                    ? GetOrAdd(result, Path.GetFileName(path))
                    : null;
            }
            else if (current is not null && line.Length > 1 && line[0] == '+')
            {
                current.Add(line[1..]);
            }
        }

        return result;
    }

    private static List<string> GetOrAdd(Dictionary<string, List<string>> map, string key)
    {
        if (!map.TryGetValue(key, out var list))
        {
            map[key] = list = [];
        }

        return list;
    }
}
