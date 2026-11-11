namespace eShop.Catalog.API;

/// <summary>
/// Rejects an out-of-range <see cref="PaginationRequest"/> with a 400 validation problem
/// before the endpoint handler runs.
/// </summary>
public sealed class PaginationValidationFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        foreach (var argument in context.Arguments)
        {
            if (argument is PaginationRequest paginationRequest)
            {
                var errors = paginationRequest.Validate();
                if (errors.Count > 0)
                {
                    return TypedResults.ValidationProblem(errors);
                }
            }
        }

        return await next(context);
    }
}

public static class PaginationValidationExtensions
{
    /// <summary>
    /// Applies <see cref="PaginationValidationFilter"/> to an endpoint that binds
    /// <c>[AsParameters] PaginationRequest</c> and documents the 400 validation problem.
    /// </summary>
    public static RouteHandlerBuilder WithPaginationValidation(this RouteHandlerBuilder builder) =>
        builder
            .AddEndpointFilter<PaginationValidationFilter>()
            .ProducesValidationProblem();
}
