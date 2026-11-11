namespace Promotions.API;

public static class PromotionsApi
{
    public static IEndpointRouteBuilder MapPromotionsApiV1(this IVersionedEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/promotions").HasApiVersion(1.0);

        // Anonymous: the storefront reads active promotions without a session. Bearer tokens are ignored.
        api.MapGet("/active", ListActivePromotions)
            .AllowAnonymous()
            .WithName("ListActivePromotions")
            .WithSummary("List active promotions")
            .WithDescription("Promotions that are active now and need no coupon, ordered by priority descending then id ascending.");

        app.MapPromotionsAdminApiV1();

        return app;
    }

    public static async Task<Ok<List<ActivePromotion>>> ListActivePromotions(ActivePromotionsQuery query, CancellationToken cancellationToken)
    {
        var promotions = await query.ListAsync(includeCouponOnly: false, cancellationToken);
        return TypedResults.Ok(promotions.Select(ActivePromotion.From).ToList());
    }
}
