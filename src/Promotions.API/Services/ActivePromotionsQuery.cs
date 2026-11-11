namespace Promotions.API.Services;

/// <summary>
/// The active-candidate query shared by the storefront feed (PROMO-2) and pricing (PROMO-3/4): promotions whose
/// effective status is <c>Active</c> now, with their targets, ordered by priority descending then id ascending.
/// </summary>
public class ActivePromotionsQuery(PromotionsContext context, TimeProvider timeProvider)
{
    /// <param name="includeCouponOnly">False for the public feed (coupon-only promotions are left out); true for pricing, which applies them only with a valid coupon.</param>
    public async Task<List<Promotion>> ListAsync(bool includeCouponOnly = false, CancellationToken cancellationToken = default)
    {
        var now = timeProvider.GetUtcNow();

        var query = context.Promotions
            .AsNoTracking()
            .Include(p => p.Targets)
            .Where(Promotion.HasEffectiveStatus(PromotionEffectiveStatus.Active, now));

        if (!includeCouponOnly)
        {
            query = query.Where(p => !p.RequiresCoupon);
        }

        return await query
            .OrderByDescending(p => p.Priority)
            .ThenBy(p => p.Id)
            .AsSplitQuery()
            .ToListAsync(cancellationToken);
    }
}
