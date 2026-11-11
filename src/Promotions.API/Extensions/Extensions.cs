internal static class Extensions
{
    public static void AddApplicationServices(this IHostApplicationBuilder builder)
    {
        builder.AddDefaultAuthentication();

        builder.Services.AddAuthorizationBuilder().AddPromotionsPolicies();

        builder.AddRabbitMqEventBus("eventbus");

        builder.AddNpgsqlDbContext<PromotionsContext>("promotionsdb");

        builder.Services.TryAddSingleton(TimeProvider.System);

        builder.Services.AddMigration<PromotionsContext, PromotionsContextSeed>();
    }
}
