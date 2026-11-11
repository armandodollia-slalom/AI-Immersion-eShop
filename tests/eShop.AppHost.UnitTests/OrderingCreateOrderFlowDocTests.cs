using System.Text.RegularExpressions;

namespace eShop.AppHost.UnitTests;

[TestClass]
[TestCategory("BUG-3")]
public class OrderingCreateOrderFlowDocTests
{
    [TestMethod]
    [TestProperty("TestCase", "TC-BUG-3-05")]
    public void TC_BUG_3_05_CreateOrderUserIdBugRowIsRemovedFromOrderingFlowDoc()
    {
        var root = FindRepositoryRoot();
        var doc = File.ReadAllText(Path.Combine(root, "testing", "flows", "ordering.md"));
        var spec = File.ReadAllText(Path.Combine(root, "e2e", "teststack", "ordering-api.spec.ts"));

        var knownIssues = doc[doc.IndexOf("## Known issues", StringComparison.Ordinal)..];
        StringAssert.DoesNotMatch(knownIssues, new Regex(@"trusts `?userId`?|creates an order on alice's account"));

        var flowRow = doc.Split('\n').Single(l => l.Contains("`userId` in the body cannot place an order for another buyer"));
        Assert.DoesNotContain("**fixme**", flowRow, flowRow);

        // The spec table counts the file's test.fixme markers (later fixes remove more of them).
        var specRow = doc.Split('\n').Single(l => l.Contains("| `ordering-api.spec.ts` |"));
        var remainingFixmes = Regex.Matches(spec, @"test\.fixme\(").Count;
        StringAssert.Contains(specRow, $"{remainingFixmes} fixme");
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
