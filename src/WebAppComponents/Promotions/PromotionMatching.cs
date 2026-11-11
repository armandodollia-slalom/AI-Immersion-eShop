using eShop.WebAppComponents.Catalog;

namespace eShop.WebAppComponents.Promotions;

public static class PromotionMatching
{
    public static bool Matches(ActivePromotion promotion, CatalogItem item)
    {
        foreach (var target in promotion.Targets ?? [])
        {
            var hit = target.Scope switch
            {
                PromotionScope.All => true,
                PromotionScope.Type => target.TargetId == item.CatalogTypeId,
                PromotionScope.Brand => target.TargetId == item.CatalogBrandId,
                PromotionScope.Product => target.TargetId == item.Id,
                _ => false,
            };
            if (hit)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Highest priority wins, ties go to the lowest id. Coupon-only promotions are ignored.</summary>
    public static ActivePromotion? BestMatch(IReadOnlyList<ActivePromotion>? promotions, CatalogItem item)
    {
        if (promotions is null)
        {
            return null;
        }

        return promotions
            .Where(p => !p.RequiresCoupon && Matches(p, item))
            .OrderByDescending(p => p.Priority)
            .ThenBy(p => p.Id)
            .FirstOrDefault();
    }
}
