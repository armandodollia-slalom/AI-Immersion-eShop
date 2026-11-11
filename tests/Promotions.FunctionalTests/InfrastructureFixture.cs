using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Npgsql;

namespace eShop.Promotions.FunctionalTests;

/// <summary>One real Postgres server and one RabbitMQ broker for the whole test run; every test gets its own empty database.</summary>
public sealed class InfrastructureFixture : IAsyncLifetime
{
    private readonly IHost _app;
    private readonly IResourceBuilder<PostgresServerResource> _postgres;
    private readonly IResourceBuilder<RabbitMQServerResource> _rabbitMq;
    private string _serverConnectionString = null!;
    private int _databases;

    public string RabbitMqConnectionString { get; private set; } = null!;

    public InfrastructureFixture()
    {
        var builder = DistributedApplication.CreateBuilder(new DistributedApplicationOptions
        {
            AssemblyName = typeof(InfrastructureFixture).Assembly.FullName,
            DisableDashboard = true
        });
        _postgres = builder.AddPostgres("postgres");
        _rabbitMq = builder.AddRabbitMQ("eventbus");
        _app = builder.Build();
    }

    public async ValueTask InitializeAsync()
    {
        await _app.StartAsync();
        _serverConnectionString = (await _postgres.Resource.GetConnectionStringAsync())!;
        RabbitMqConnectionString = (await _rabbitMq.Resource.ConnectionStringExpression.GetValueAsync(CancellationToken.None))!;
    }

    /// <summary>Create an empty database (no tables) and return its connection string.</summary>
    public async Task<string> CreateDatabaseAsync()
    {
        var name = $"promotionsdb_{Interlocked.Increment(ref _databases)}_{Guid.NewGuid():N}";
        await using (var connection = new NpgsqlConnection(_serverConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand($"CREATE DATABASE \"{name}\"", connection);
            await command.ExecuteNonQueryAsync();
        }

        return new NpgsqlConnectionStringBuilder(_serverConnectionString) { Database = name }.ConnectionString;
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        if (_app is IAsyncDisposable disposable)
        {
            await disposable.DisposeAsync();
        }
        else
        {
            _app.Dispose();
        }
    }
}

[CollectionDefinition(Name)]
public sealed class InfrastructureCollection : ICollectionFixture<InfrastructureFixture>
{
    public const string Name = "Promotions infrastructure";
}
