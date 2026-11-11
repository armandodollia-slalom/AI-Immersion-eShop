using Promotions.API.IntegrationEvents;

internal static class Extensions
{
    public static void AddApplicationServices(this IHostApplicationBuilder builder)
    {
        builder.AddDefaultAuthentication();

        builder.Services.AddAuthorizationBuilder().AddPromotionsPolicies();

        builder.AddRabbitMqEventBus("eventbus");

        builder.AddNpgsqlDbContext<PromotionsContext>("promotionsdb");

        builder.Services.TryAddSingleton(TimeProvider.System);

        // Migrates (and seeds) in StartAsync, so it runs before PromotionLifecycleWorker below.
        builder.Services.AddMigration<PromotionsContext, PromotionsContextSeed>();

        // Outbox (IntegrationEventLog table in PromotionsContext) for the promotion start and end events.
        builder.Services.AddTransient<IIntegrationEventLogService, IntegrationEventLogService<PromotionsContext>>();
        builder.Services.AddTransient<IPromotionsIntegrationEventService, PromotionsIntegrationEventService>();

        builder.Services.AddScoped<ActivePromotionsQuery>();
        builder.Services.AddHostedService<PromotionLifecycleWorker>();
    }
}
