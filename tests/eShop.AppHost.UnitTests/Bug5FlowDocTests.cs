namespace eShop.AppHost.UnitTests;

[TestClass]
[TestCategory("BUG-5")]
public class Bug5FlowDocTests
{
    [TestMethod]
    [TestProperty("TestCase", "TC-BUG-5-08")]
    public void TC_BUG_5_08_FlowsHaveNoProtocolRelativeReturnUrlBugRow()
    {
        var flows = Path.Combine(FindRepoRoot(), "testing", "flows");
        Assert.IsTrue(Directory.Exists(flows));

        var bugRows = Directory.EnumerateFiles(flows, "*.md")
            .SelectMany(file => File.ReadLines(file).Select(line => (file, line)))
            .Where(x => x.line.TrimStart().StartsWith('|')
                && x.line.Contains("returnUrl", StringComparison.OrdinalIgnoreCase)
                && (x.line.Contains("protocol-relative", StringComparison.OrdinalIgnoreCase)
                    || x.line.Contains("open redirect", StringComparison.OrdinalIgnoreCase)
                    || x.line.Contains("//evil", StringComparison.OrdinalIgnoreCase)))
            .Select(x => $"{Path.GetFileName(x.file)}: {x.line}")
            .ToList();

        CollectionAssert.AreEqual(Array.Empty<string>(), bugRows);
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "eShop.slnx")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("eShop.slnx not found");
    }
}
