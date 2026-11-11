namespace eShop.AppHost.UnitTests;

[TestClass]
[TestCategory("BUG-14")]
public class FlowsBugsTableTests
{
    private const string FixedBugTest =
        "typing a quantity, pressing Enter, then clicking Decrease reliably stores the decremented quantity";

    [TestMethod]
    [TestProperty("TestCase", "TC-BUG-14-06")]
    public void TC_BUG_14_06_Bugs_table_in_testing_flows_has_no_row_for_this_bug()
    {
        var flows = Path.Combine(FindRepositoryRoot(), "testing", "flows");

        foreach (var file in Directory.GetFiles(flows, "*.md"))
        {
            var rows = File.ReadAllLines(file).Where(l => l.TrimStart().StartsWith('|') && l.Contains(FixedBugTest));
            Assert.IsFalse(rows.Any(), $"{Path.GetFileName(file)} still has a bugs-table row for the fixed bug");
        }

        var lines = File.ReadAllLines(Path.Combine(flows, "identity-basket.md"));
        var start = Array.FindIndex(lines, l => l.StartsWith("## Bugs found"));
        Assert.IsGreaterThanOrEqualTo(0, start, "missing ## Bugs found section");
        var table = lines.Skip(start + 1).TakeWhile(l => !l.StartsWith("## ")).Where(l => l.StartsWith('|')).Skip(2).ToList();
        Assert.HasCount(3, table);
        StringAssert.Contains(table[0], "Open redirect");
        StringAssert.Contains(table[1], "zero and negative quantities");
        StringAssert.Contains(table[2], "`basket` scope");

        var covered = lines.Single(l => l.StartsWith("- **Covered by:**") && l.Contains("removing lines updates the bag"));
        StringAssert.Contains(covered, "typing a quantity, pressing Enter, then clicking Decrease");
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
