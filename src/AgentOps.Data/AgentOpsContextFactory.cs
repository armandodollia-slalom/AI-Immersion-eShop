using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace AgentOps.Data;

/// <summary>Design-time factory used only by `dotnet ef migrations add`; it never opens a connection.</summary>
internal sealed class AgentOpsContextFactory : IDesignTimeDbContextFactory<AgentOpsContext>
{
    public AgentOpsContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<AgentOpsContext>().UseNpgsql("Host=localhost;Database=agentopsdb").Options);
}
