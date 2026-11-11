namespace eShop.WebAppComponents.Promotions;

public static class PromotionPricing
{
    public static decimal SalePrice(decimal price, decimal percent)
        => Math.Round(price * (1 - percent / 100m), 2, MidpointRounding.ToEven);
}
