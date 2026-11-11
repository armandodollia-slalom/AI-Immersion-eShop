using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace eShop.Promotions.FunctionalTests;

/// <summary>A TimeProvider whose "now" the test sets (the system under test reads time only through TimeProvider).</summary>
public sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => now;
}

/// <summary>
/// The real Promotions.API in-process against a real Postgres database. Any public type of the Promotions.API
/// assembly selects the entry point (its generated Program class is internal).
/// </summary>
public sealed class PromotionsApiHost : WebApplicationFactory<global::Promotions.API.Model.PromotionDetails>
{
    private readonly string _databaseConnectionString;
    private readonly string _rabbitMqConnectionString;
    private readonly bool _seedingDisabled;
    private readonly TimeProvider? _timeProvider;

    public PromotionsApiHost(string databaseConnectionString, string rabbitMqConnectionString, bool seedingDisabled = false, TimeProvider? timeProvider = null)
    {
        _databaseConnectionString = databaseConnectionString;
        _rabbitMqConnectionString = rabbitMqConnectionString;
        _seedingDisabled = seedingDisabled;
        _timeProvider = timeProvider;
    }

    /// <summary>The environment the host runs in (MapDefaultEndpoints maps /health and /alive only in Development).</summary>
    public string Environment { get; init; } = Environments.Development;

    // Host configuration is the only configuration Program sees before it reads the connection strings (AddNpgsqlDbContext).
    protected override IHost CreateHost(IHostBuilder builder)
    {
        builder.ConfigureHostConfiguration(config =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:promotionsdb"] = _databaseConnectionString,
                ["ConnectionStrings:eventbus"] = _rabbitMqConnectionString,
                // Unreachable authority: tokens never validate, so every token request must be answered with 401.
                ["Identity:Url"] = "http://identity.test",
                ["Seeding:Disabled"] = _seedingDisabled ? "true" : "false",
            });
        });
        return base.CreateHost(builder);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(Environment);
        builder.ConfigureTestServices(services =>
        {
            if (_timeProvider is not null)
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton(_timeProvider);
            }
        });
    }

    public PromotionsContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<PromotionsContext>().UseNpgsql(_databaseConnectionString).Options;
        return new PromotionsContext(options);
    }
}
