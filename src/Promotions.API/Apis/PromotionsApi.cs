namespace Promotions.API;

public static class PromotionsApi
{
    public static IEndpointRouteBuilder MapPromotionsApiV1(this IVersionedEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/promotions").HasApiVersion(1.0);

        // Anonymous: storefront reads active promotions without a session. Bearer tokens are ignored.
        api.MapGet("/active", async (PromotionsContext context, TimeProvider timeProvider) =>
        {
            var now = timeProvider.GetUtcNow();
            var data = await context.Promotions
                .AsNoTracking()
                .Where(p => p.Status == PromotionStatus.Published && p.StartsAt <= now && now < p.EndsAt)
                .OrderByDescending(p => p.Priority)
                .ThenBy(p => p.Id)
                .Select(p => new PromotionDto(p.Id, p.Name, p.Type.ToString(), p.Status.ToString(), p.StartsAt, p.EndsAt, p.Priority, p.RequiresCoupon))
                .ToListAsync();
            return TypedResults.Ok(data);
        })
        .AllowAnonymous()
        .WithName("ListActivePromotions")
        .WithSummary("List active promotions");

        api.MapGet("/", async (PromotionsContext context) =>
        {
            var data = await context.Promotions
                .AsNoTracking()
                .OrderByDescending(p => p.Priority)
                .ThenBy(p => p.Id)
                .Select(p => new PromotionDto(p.Id, p.Name, p.Type.ToString(), p.Status.ToString(), p.StartsAt, p.EndsAt, p.Priority, p.RequiresCoupon))
                .ToListAsync();
            return TypedResults.Ok(data);
        })
        .RequireAuthorization()
        .WithName("ListPromotions")
        .WithSummary("List all promotions");

        return app;
    }
}

public record PromotionDto(
    int Id,
    string Name,
    string Type,
    string Status,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    int Priority,
    bool RequiresCoupon);
