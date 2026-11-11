using eShop.Basket.API.Grpc;
using eShop.WebApp.Services.OrderStatus.IntegrationEvents;
using eShop.WebApp.Services.Promotions;
using eShop.WebApp.Services.Promotions.IntegrationEvents;
using eShop.WebAppComponents.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Server;
using Microsoft.Extensions.AI;
using Microsoft.IdentityModel.JsonWebTokens;

public static class Extensions
{
    /// <summary>Authorization policy for store administrators (role 'admin' issued by Identity.API).</summary>
    public const string AdminPolicy = "Admin";

    private const string AdminRole = "admin";
    private const string RoleClaimType = "role";

    public static void AddApplicationServices(this IHostApplicationBuilder builder)
    {
        builder.AddAuthenticationServices();

        builder.AddRabbitMqEventBus("EventBus")
               .AddEventBusSubscriptions();

        builder.Services.AddHttpForwarderWithServiceDiscovery();

        // Application services
        builder.Services.AddScoped<BasketState>();
        builder.Services.AddScoped<LogOutService>();
        builder.Services.AddSingleton<BasketService>();
        builder.Services.AddSingleton<OrderStatusNotificationService>();
        builder.Services.AddSingleton<IProductImageUrlProvider, ProductImageUrlProvider>();
        builder.AddAIServices();

        // HTTP and GRPC client registrations
        builder.Services.AddGrpcClient<Basket.BasketClient>(o => o.Address = new("http://basket-api"))
            .AddAuthToken();

        builder.Services.AddHttpClient<CatalogService>(o => o.BaseAddress = new("https+http://catalog-api"))
            .AddApiVersion(2.0)
            .AddAuthToken();

        builder.Services.AddMemoryCache();
        builder.Services.AddHttpClient<PromotionsService>(o =>
            {
                o.BaseAddress = new("https+http://promotions-api");
                o.Timeout = TimeSpan.FromSeconds(2);
            })
            .AddApiVersion(1.0);

        builder.Services.AddHttpClient<OrderingService>(o => o.BaseAddress = new("https+http://ordering-api"))
            .AddApiVersion(1.0)
            .AddAuthToken();
    }

    public static void AddEventBusSubscriptions(this IEventBusBuilder eventBus)
    {
        eventBus.AddSubscription<OrderStatusChangedToAwaitingValidationIntegrationEvent, OrderStatusChangedToAwaitingValidationIntegrationEventHandler>();
        eventBus.AddSubscription<OrderStatusChangedToPaidIntegrationEvent, OrderStatusChangedToPaidIntegrationEventHandler>();
        eventBus.AddSubscription<OrderStatusChangedToStockConfirmedIntegrationEvent, OrderStatusChangedToStockConfirmedIntegrationEventHandler>();
        eventBus.AddSubscription<OrderStatusChangedToShippedIntegrationEvent, OrderStatusChangedToShippedIntegrationEventHandler>();
        eventBus.AddSubscription<OrderStatusChangedToCancelledIntegrationEvent, OrderStatusChangedToCancelledIntegrationEventHandler>();
        eventBus.AddSubscription<OrderStatusChangedToSubmittedIntegrationEvent, OrderStatusChangedToSubmittedIntegrationEventHandler>();
        eventBus.AddSubscription<PromotionStartedIntegrationEvent, PromotionStartedIntegrationEventHandler>();
        eventBus.AddSubscription<PromotionEndedIntegrationEvent, PromotionEndedIntegrationEventHandler>();
    }

    public static void AddAuthenticationServices(this IHostApplicationBuilder builder)
    {
        var configuration = builder.Configuration;
        var services = builder.Services;

        JsonWebTokenHandler.DefaultInboundClaimTypeMap.Remove("sub");
        // Keep Identity.API's 'role' claim as 'role' (it is the RoleClaimType below) instead of
        // mapping it to ClaimTypes.Role.
        JsonWebTokenHandler.DefaultInboundClaimTypeMap.Remove(RoleClaimType);

        var identityUrl = configuration.GetRequiredValue("IdentityUrl");
        var callBackUrl = configuration.GetRequiredValue("CallBackUrl");
        var sessionCookieLifetime = configuration.GetValue("SessionCookieLifetimeMinutes", 60);

        // Add Authentication services
        services.AddAuthorizationBuilder()
            .AddPolicy(AdminPolicy, policy => policy.RequireAuthenticatedUser().RequireRole(AdminRole));
        services.AddAuthentication(options =>
        {
            options.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
            options.DefaultChallengeScheme = OpenIdConnectDefaults.AuthenticationScheme;
        })
        .AddCookie(options =>
        {
            options.ExpireTimeSpan = TimeSpan.FromMinutes(sessionCookieLifetime);
            // Signed in but not allowed (e.g. a non-admin on an Admin page): answer 403 instead of
            // redirecting to the non-existent /Account/AccessDenied page.
            options.Events.OnRedirectToAccessDenied = context =>
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            };
        })
        .AddOpenIdConnect(options =>
        {
            options.SignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
            options.Authority = identityUrl;
            options.SignedOutRedirectUri = callBackUrl;
            options.ClientId = "webapp";
            options.ClientSecret = "secret";
            options.ResponseType = "code";
            options.SaveTokens = true;
            options.GetClaimsFromUserInfoEndpoint = true;
            options.RequireHttpsMetadata = false;
            options.Scope.Add("openid");
            options.Scope.Add("profile");
            options.Scope.Add("orders");
            options.Scope.Add("basket");
            options.Scope.Add("promotions");
            options.TokenValidationParameters.RoleClaimType = RoleClaimType;
            options.ClaimActions.MapUniqueJsonKey(RoleClaimType, RoleClaimType);
        });

        // Blazor auth services
        services.AddScoped<AuthenticationStateProvider, ServerAuthenticationStateProvider>();
        services.AddCascadingAuthenticationState();
    }

    private static void AddAIServices(this IHostApplicationBuilder builder)
    {
        ChatClientBuilder? chatClientBuilder = null;
        if (builder.Configuration["OllamaEnabled"] is string ollamaEnabled && bool.Parse(ollamaEnabled))
        {
            chatClientBuilder = builder.AddOllamaApiClient("chat")
                .AddChatClient();
        }
        else if (!string.IsNullOrWhiteSpace(builder.Configuration.GetConnectionString("chatModel")))
        {
            chatClientBuilder = builder.AddOpenAIClientFromConfiguration("chatModel")
                .AddChatClient();
        }

        chatClientBuilder?.UseFunctionInvocation();
    }

    public static async Task<string?> GetBuyerIdAsync(this AuthenticationStateProvider authenticationStateProvider)
    {
        var authState = await authenticationStateProvider.GetAuthenticationStateAsync();
        var user = authState.User;
        return user.FindFirst("sub")?.Value;
    }

    public static async Task<string?> GetUserNameAsync(this AuthenticationStateProvider authenticationStateProvider)
    {
        var authState = await authenticationStateProvider.GetAuthenticationStateAsync();
        var user = authState.User;
        return user.FindFirst("name")?.Value;
    }
}
