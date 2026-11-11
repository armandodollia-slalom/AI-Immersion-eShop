using System.Text.RegularExpressions;

namespace eShop.AppHost.UnitTests;

[TestClass]
[TestCategory("BUG-2")]
public class OrderingCancelShipFlowDocTests
{
    [TestMethod]
    [TestProperty("TestCase", "TC-BUG-2-12")]
    public void TC_BUG_2_12_CancelShipOwnershipTestIsNoLongerFixmeInOrderingApiSpec()
    {
        var spec = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "e2e", "teststack", "ordering-api.spec.ts"));

        var start = spec.IndexOf("a buyer cannot cancel or ship another buyer", StringComparison.Ordinal);
        Assert.IsGreaterThanOrEqualTo(0, start, "the ownership test is missing from ordering-api.spec.ts");
        var testBody = spec[start..];
        var next = testBody.IndexOf("\n  test(", 1, StringComparison.Ordinal);
        if (next > 0)
        {
            testBody = testBody[..next];
        }

        Assert.DoesNotContain("test.fixme", testBody);
        Assert.Contains("toBe(404)", testBody);
        Assert.Contains("toBe(403)", testBody);
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-BUG-2-13")]
    public void TC_BUG_2_13_CancelShipOwnershipBugRowIsRemovedFromOrderingFlowDoc()
    {
        var root = FindRepositoryRoot();
        var doc = File.ReadAllText(Path.Combine(root, "testing", "flows", "ordering.md"));
        var spec = File.ReadAllText(Path.Combine(root, "e2e", "teststack", "ordering-api.spec.ts"));

        var knownIssues = doc[doc.IndexOf("## Known issues", StringComparison.Ordinal)..];
        StringAssert.DoesNotMatch(knownIssues, new Regex(@"no ownership or role check|alice ships bob's Paid order"));

        var flowRow = doc.Split('\n').Single(l => l.Contains("A buyer cannot cancel or ship another buyer's order"));
        Assert.DoesNotContain("**fixme**", flowRow, flowRow);

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
