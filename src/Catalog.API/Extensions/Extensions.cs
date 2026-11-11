using eShop.Catalog.API.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;

public static class Extensions
{
    public static void AddApplicationServices(this IHostApplicationBuilder builder)
    {
        builder.AddDefaultAuthentication();
        builder.Services.Configure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, options =>
        {
            // Read roles from the raw JWT "role" claim instead of the mapped ClaimTypes.Role
            options.MapInboundClaims = false;
            options.TokenValidationParameters.RoleClaimType = "role";
        });
        builder.Services.AddAuthorizationBuilder()
            .AddPolicy("CatalogAdmin", policy => policy.RequireAuthenticatedUser().RequireRole("Admin"));

        // Avoid loading full database config and migrations if startup
        // is being invoked from build-time OpenAPI generation
        if (builder.Environment.IsBuild())
        {
            builder.Services.AddDbContext<CatalogContext>();
            // The OpenAPI document needs an identity URL, which is only injected at run time
            builder.Configuration["Identity:Url"] ??= "http://localhost";
            return;
        }

        builder.AddNpgsqlDbContext<CatalogContext>("catalogdb", configureDbContextOptions: dbContextOptionsBuilder =>
        {
            dbContextOptionsBuilder.UseNpgsql(builder =>
            {
                builder.UseVector();
            });
        });

        // REVIEW: This is done for development ease but shouldn't be here in production
        builder.Services.AddMigration<CatalogContext, CatalogContextSeed>();

        // Add the integration services that consume the DbContext
        builder.Services.AddTransient<IIntegrationEventLogService, IntegrationEventLogService<CatalogContext>>();

        builder.Services.AddTransient<ICatalogIntegrationEventService, CatalogIntegrationEventService>();

        builder.AddRabbitMqEventBus("eventbus")
               .AddSubscription<OrderStatusChangedToAwaitingValidationIntegrationEvent, OrderStatusChangedToAwaitingValidationIntegrationEventHandler>()
               .AddSubscription<OrderStatusChangedToPaidIntegrationEvent, OrderStatusChangedToPaidIntegrationEventHandler>();

        builder.Services.AddOptions<CatalogOptions>()
            .BindConfiguration(nameof(CatalogOptions));

        if (builder.Configuration["OllamaEnabled"] is string ollamaEnabled && bool.Parse(ollamaEnabled))
        {
            builder.AddOllamaApiClient("embedding")
                .AddEmbeddingGenerator();
        }
        else if (!string.IsNullOrWhiteSpace(builder.Configuration.GetConnectionString("textEmbeddingModel")))
        {
            builder.AddOpenAIClientFromConfiguration("textEmbeddingModel")
                .AddEmbeddingGenerator();
        }

        builder.Services.AddScoped<ICatalogAI, CatalogAI>();
    }
}
