using Promotions.API.IntegrationEvents;

namespace Promotions.API;

/// <summary>Admin CRUD and lifecycle endpoints. Every route requires <see cref="PromotionsPolicies.Admin"/>: anonymous 401, non-admin 403.</summary>
public static class PromotionsAdminApi
{
    public const int MaxPageSize = 100;

    public static IEndpointRouteBuilder MapPromotionsAdminApiV1(this IVersionedEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/promotions")
            .HasApiVersion(1.0)
            .RequireAuthorization(PromotionsPolicies.Admin);

        api.MapGet("/", ListPromotions)
            .WithName("ListPromotions")
            .WithSummary("List promotions")
            .WithDescription("Paged list of all promotions, optionally filtered by effective status (Draft, Scheduled, Active, Expired).");

        api.MapGet("/{id:int}", GetPromotion)
            .WithName("GetPromotion")
            .WithSummary("Get a promotion");

        api.MapPost("/", CreatePromotion)
            .WithName("CreatePromotion")
            .WithSummary("Create a promotion")
            .WithDescription("Always saved as Draft; no event is published.");

        api.MapPut("/{id:int}", UpdatePromotion)
            .WithName("UpdatePromotion")
            .WithSummary("Update a promotion")
            .WithDescription("Only allowed while the promotion is Draft or Scheduled; 409 when Active or Expired.");

        api.MapPost("/{id:int}/publish", PublishPromotion)
            .WithName("PublishPromotion")
            .WithSummary("Publish a draft promotion");

        api.MapPost("/{id:int}/end", EndPromotion)
            .WithName("EndPromotion")
            .WithSummary("End a promotion now");

        return app;
    }

    public static async Task<Results<Ok<PaginatedItems<PromotionDetails>>, ValidationProblem>> ListPromotions(
        PromotionsContext context,
        TimeProvider timeProvider,
        string? status,
        int page = 0,
        int pageSize = 20,
        CancellationToken cancellationToken = default)
    {
        var errors = new Dictionary<string, string[]>();
        PromotionEffectiveStatus? effectiveStatus = null;
        if (!string.IsNullOrEmpty(status))
        {
            if (Enum.TryParse<PromotionEffectiveStatus>(status, ignoreCase: true, out var parsed) && Enum.IsDefined(parsed) && !int.TryParse(status, out _))
            {
                effectiveStatus = parsed;
            }
            else
            {
                errors["status"] = ["Status must be Draft, Scheduled, Active or Expired."];
            }
        }

        if (page < 0)
        {
            errors["page"] = ["Page must be 0 or greater."];
        }

        if (pageSize is < 1 or > MaxPageSize)
        {
            errors["pageSize"] = [$"PageSize must be between 1 and {MaxPageSize}."];
        }

        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        var now = timeProvider.GetUtcNow();
        var query = context.Promotions.AsNoTracking();
        if (effectiveStatus is { } filter)
        {
            query = query.Where(Promotion.HasEffectiveStatus(filter, now));
        }

        var count = await query.LongCountAsync(cancellationToken);
        var promotions = await query
            .Include(p => p.Targets)
            .OrderBy(p => p.Id)
            .Skip(page * pageSize)
            .Take(pageSize)
            .AsSplitQuery()
            .ToListAsync(cancellationToken);

        return TypedResults.Ok(new PaginatedItems<PromotionDetails>(page, pageSize, count, promotions.Select(p => PromotionDetails.From(p, now)).ToList()));
    }

    public static async Task<Results<Ok<PromotionDetails>, NotFound>> GetPromotion(
        int id, PromotionsContext context, TimeProvider timeProvider, CancellationToken cancellationToken)
    {
        var promotion = await context.Promotions.AsNoTracking().Include(p => p.Targets).FirstOrDefaultAsync(p => p.Id == id, cancellationToken);
        return promotion is null
            ? TypedResults.NotFound()
            : TypedResults.Ok(PromotionDetails.From(promotion, timeProvider.GetUtcNow()));
    }

    public static async Task<Results<Created<PromotionDetails>, ValidationProblem>> CreatePromotion(
        PromotionRequest request, PromotionsContext context, TimeProvider timeProvider, CancellationToken cancellationToken)
    {
        var errors = PromotionValidator.Validate(request);
        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        var promotion = new Promotion { Name = string.Empty, Status = PromotionStatus.Draft };
        PromotionValidator.Apply(request, promotion);

        context.Promotions.Add(promotion);
        await context.SaveChangesAsync(cancellationToken);

        return TypedResults.Created($"/api/promotions/{promotion.Id}", PromotionDetails.From(promotion, timeProvider.GetUtcNow()));
    }

    public static async Task<Results<Ok<PromotionDetails>, NotFound, ProblemHttpResult, ValidationProblem>> UpdatePromotion(
        int id,
        PromotionRequest request,
        PromotionsContext context,
        IPromotionsIntegrationEventService eventService,
        PromotionCache promotionCache,
        TimeProvider timeProvider,
        CancellationToken cancellationToken)
    {
        var promotion = await context.Promotions.Include(p => p.Targets).FirstOrDefaultAsync(p => p.Id == id, cancellationToken);
        if (promotion is null)
        {
            return TypedResults.NotFound();
        }

        var now = timeProvider.GetUtcNow();
        if (!promotion.CanEdit(now))
        {
            return Conflict($"Promotion {id} is {promotion.GetEffectiveStatus(now)}; only Draft or Scheduled promotions can be edited.");
        }

        var errors = PromotionValidator.Validate(request);
        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        PromotionValidator.Apply(request, promotion);

        // A published promotion moved to a start in the past is active now: send its start event at once.
        return await SaveWithEventsAsync(promotion, context, eventService, promotionCache, now, cancellationToken)
            ? TypedResults.Ok(PromotionDetails.From(promotion, now))
            : ConcurrentChange(id);
    }

    public static async Task<Results<Ok<PromotionDetails>, NotFound, ProblemHttpResult>> PublishPromotion(
        int id,
        PromotionsContext context,
        IPromotionsIntegrationEventService eventService,
        PromotionCache promotionCache,
        TimeProvider timeProvider,
        CancellationToken cancellationToken)
    {
        var promotion = await context.Promotions.Include(p => p.Targets).FirstOrDefaultAsync(p => p.Id == id, cancellationToken);
        if (promotion is null)
        {
            return TypedResults.NotFound();
        }

        if (!promotion.Publish())
        {
            return Conflict($"Promotion {id} is {promotion.Status}; only a Draft promotion can be published.");
        }

        var now = timeProvider.GetUtcNow();

        // Already started: the start event goes out now (once); otherwise PromotionLifecycleWorker sends it after StartsAt.
        return await SaveWithEventsAsync(promotion, context, eventService, promotionCache, now, cancellationToken)
            ? TypedResults.Ok(PromotionDetails.From(promotion, now))
            : ConcurrentChange(id);
    }

    public static async Task<Results<NoContent, NotFound, ProblemHttpResult>> EndPromotion(
        int id,
        PromotionsContext context,
        IPromotionsIntegrationEventService eventService,
        PromotionCache promotionCache,
        TimeProvider timeProvider,
        CancellationToken cancellationToken)
    {
        var promotion = await context.Promotions.Include(p => p.Targets).FirstOrDefaultAsync(p => p.Id == id, cancellationToken);
        if (promotion is null)
        {
            return TypedResults.NotFound();
        }

        promotion.End();

        // A promotion that had started gets its end event at once; one that never started has nothing to end for subscribers.
        return await SaveWithEventsAsync(promotion, context, eventService, promotionCache, timeProvider.GetUtcNow(), cancellationToken)
            ? TypedResults.NoContent()
            : ConcurrentChange(id);
    }

    private static async Task<bool> SaveWithEventsAsync(
        Promotion promotion,
        PromotionsContext context,
        IPromotionsIntegrationEventService eventService,
        PromotionCache promotionCache,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var events = PromotionLifecycleEvents.TakeDue(promotion, now);
        try
        {
            await eventService.SaveEventsAndPromotionsContextChangesAsync(events, cancellationToken);
        }
        catch (DbUpdateConcurrencyException)
        {
            return false;
        }

        // Pricing must see a published, changed or ended promotion at once, not after the 30s cache window.
        promotionCache.Invalidate();

        foreach (var evt in events)
        {
            await eventService.PublishThroughEventBusAsync(evt);
        }

        return true;
    }

    private static ProblemHttpResult Conflict(string detail) =>
        TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "Conflict", detail: detail);

    private static ProblemHttpResult ConcurrentChange(int id) =>
        Conflict($"Promotion {id} was changed by another request; reload it and try again.");
}
