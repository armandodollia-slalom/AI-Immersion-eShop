using System.Text.RegularExpressions;

namespace eShop.AppHost.UnitTests;

[TestClass]
[TestCategory("BUG-1")]
public class OrderingFlowDocTests
{
    [TestMethod]
    [TestProperty("TestCase", "TC-BUG-1-08")]
    public void TC_BUG_1_08_OrderDetailsIdorBugRowIsRemovedFromOrderingFlowDoc()
    {
        var root = FindRepositoryRoot();
        var doc = File.ReadAllText(Path.Combine(root, "testing", "flows", "ordering.md"));
        var spec = File.ReadAllText(Path.Combine(root, "e2e", "teststack", "ordering-api.spec.ts"));

        var knownIssues = doc[doc.IndexOf("## Known issues", StringComparison.Ordinal)..];
        StringAssert.DoesNotMatch(knownIssues, new Regex(@"GET /api/orders/\{id\}|reads? bob's order 7|another buyer's order by id"));

        var flowRow = doc.Split('\n').Single(l => l.Contains("A buyer reads another buyer's order by id"));
        Assert.IsFalse(flowRow.Contains("**fixme**"), flowRow);

        // The spec table must count the file's remaining test.fixme markers, and the fixed test must not be one.
        var specRow = doc.Split('\n').Single(l => l.Contains("| `ordering-api.spec.ts` |"));
        var remainingFixmes = Regex.Matches(spec, @"test\.fixme\(").Count;
        StringAssert.Contains(specRow, $"{remainingFixmes} fixme");
        StringAssert.DoesNotMatch(spec, new Regex(@"test\.fixme\([^;]*IDOR"));
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "eShop.slnx")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new DirectoryNotFoundException("Could not locate the eShop repository root.");
    }
}
