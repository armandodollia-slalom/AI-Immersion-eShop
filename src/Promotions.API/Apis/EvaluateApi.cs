using System.Security.Claims;

namespace Promotions.API;

/// <summary><c>POST /api/promotions/evaluate</c>: prices a cart with the active promotions. Read-only: coupons are never used up here.</summary>
public static class EvaluateApi
{
    public const int MaxLines = 100;

    public static IEndpointRouteBuilder MapEvaluateApiV1(this IVersionedEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/promotions")
            .HasApiVersion(1.0)
            .RequireAuthorization();

        api.MapPost("/evaluate", EvaluateCart)
            .WithName("EvaluateCart")
            .WithSummary("Price a cart with the active promotions")
            .WithDescription("Works out each line's best discount, the order-level discount, the coupon status and the next order threshold. The buyer is the token's sub claim; there are no side effects.");

        return app;
    }

    public static async Task<Results<Ok<PricingResult>, ValidationProblem, UnauthorizedHttpResult>> EvaluateCart(
        EvaluateRequest request,
        ClaimsPrincipal user,
        PromotionCache promotionCache,
        ICouponValidator couponValidator,
        CancellationToken cancellationToken)
    {
        var buyerId = user.GetUserId();
        if (string.IsNullOrEmpty(buyerId))
        {
            return TypedResults.Unauthorized();
        }

        var errors = Validate(request);
        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        var lines = request.Items!;
        var subtotal = lines.Sum(line => line.UnitPrice * line.Quantity);
        var couponCode = string.IsNullOrWhiteSpace(request.CouponCode) ? null : request.CouponCode.Trim();

        var coupon = await couponValidator.ValidateAsync(couponCode, buyerId, subtotal, cancellationToken);
        var candidates = await promotionCache.GetActiveAsync(cancellationToken);

        return TypedResults.Ok(PricingEngine.Evaluate(candidates, lines, coupon));
    }

    /// <summary>1 to <see cref="MaxLines"/> lines, distinct product ids, unit price at least 0 and quantity at least 1.</summary>
    public static Dictionary<string, string[]> Validate(EvaluateRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        var items = request?.Items;

        if (items is null || items.Count == 0)
        {
            errors["items"] = ["Items must contain at least one line."];
            return errors;
        }

        if (items.Count > MaxLines)
        {
            errors["items"] = [$"Items must contain at most {MaxLines} lines."];
            return errors;
        }

        var seen = new HashSet<int>();
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            if (item is null)
            {
                errors[$"items[{i}]"] = ["Line must not be null."];
                continue;
            }

            if (!seen.Add(item.ProductId))
            {
                errors[$"items[{i}].productId"] = [$"Product {item.ProductId} appears more than once."];
            }

            if (item.UnitPrice < 0)
            {
                errors[$"items[{i}].unitPrice"] = ["UnitPrice must be 0 or greater."];
            }

            if (item.Quantity < 1)
            {
                errors[$"items[{i}].quantity"] = ["Quantity must be 1 or greater."];
            }
        }

        return errors;
    }
}
