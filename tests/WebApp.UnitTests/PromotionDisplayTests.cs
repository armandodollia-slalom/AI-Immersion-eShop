using System.Net;
using System.Text.Json;
using eShop.WebApp.Services.Promotions;
using eShop.WebAppComponents.Catalog;
using eShop.WebAppComponents.Promotions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

namespace eShop.WebApp.UnitTests;

// PROMO-6: tests/plans/PROMO-6-storefront-promotion-display (unit cases TC-PROMO-6-19 to TC-PROMO-6-24).
[TestClass]
[TestCategory("PROMO-6")]
public class PromotionDisplayTests
{
    private static CatalogItem Item(int id, int typeId, int brandId) =>
        new(id, $"Item {id}", "", 10m, "", brandId, new CatalogBrand(brandId, $"Brand {brandId}"), typeId, new CatalogItemType(typeId, $"Type {typeId}"));

    private static ActivePromotion Promotion(
        int id,
        int priority = 1,
        bool requiresCoupon = false,
        PromotionType type = PromotionType.PercentOff,
        params PromotionTarget[] targets) =>
        new(id, $"Promotion {id}", $"Description {id}", type, 20m, "-20%",
            targets.Length == 0 ? [new PromotionTarget(PromotionScope.All, null)] : targets,
            DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(90), priority, requiresCoupon);

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-6-19")]
    public void TC_PROMO_6_19_SalePrice_returns_rounded_percent_off_price()
    {
        Assert.AreEqual(63.99m, PromotionPricing.SalePrice(79.99m, 20m));
        Assert.AreEqual(239.99m, PromotionPricing.SalePrice(299.99m, 20m));
        Assert.AreEqual(17.59m, PromotionPricing.SalePrice(21.99m, 20m));
        Assert.AreEqual(319.20m, PromotionPricing.SalePrice(399.00m, 20m));
        Assert.AreEqual(104.49m, PromotionPricing.SalePrice(109.99m, 5m));

        foreach (var result in new[]
        {
            PromotionPricing.SalePrice(79.99m, 20m), PromotionPricing.SalePrice(299.99m, 20m), PromotionPricing.SalePrice(21.99m, 20m),
            PromotionPricing.SalePrice(399.00m, 20m), PromotionPricing.SalePrice(109.99m, 5m),
        })
        {
            Assert.AreEqual(result, decimal.Round(result, 2), "no more than 2 decimals");
        }
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-6-20")]
    public void TC_PROMO_6_20_SalePrice_with_value_100_returns_zero()
    {
        var result = PromotionPricing.SalePrice(79.99m, 100m);

        Assert.AreEqual(0.00m, result);
        Assert.IsGreaterThanOrEqualTo(0m, result);
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-6-21")]
    public void TC_PROMO_6_21_Matches_uses_only_the_column_the_target_scope_names()
    {
        var item = Item(24, typeId: 4, brandId: 3);

        bool Matches(PromotionScope scope, int? targetId) =>
            PromotionMatching.Matches(Promotion(1, targets: new PromotionTarget(scope, targetId)), item);

        Assert.IsFalse(Matches(PromotionScope.Type, 3));
        Assert.IsTrue(Matches(PromotionScope.Brand, 3));
        Assert.IsTrue(Matches(PromotionScope.Type, 4));
        Assert.IsTrue(Matches(PromotionScope.Product, 24));
        Assert.IsFalse(Matches(PromotionScope.Product, 3));
        Assert.IsTrue(Matches(PromotionScope.All, null));
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-6-22")]
    public void TC_PROMO_6_22_BestMatch_picks_highest_priority_and_breaks_ties_by_lowest_id()
    {
        var item = Item(3, typeId: 3, brandId: 3);
        var promotions = new List<ActivePromotion> { Promotion(3, priority: 20), Promotion(1, priority: 10), Promotion(2, priority: 20) };

        var best = PromotionMatching.BestMatch(promotions, item);

        Assert.IsNotNull(best);
        Assert.AreEqual(2, best.Id);
        Assert.AreEqual(20, best.Priority);
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-6-23")]
    public void TC_PROMO_6_23_BestMatch_ignores_coupon_only_promotions()
    {
        var item = Item(3, typeId: 3, brandId: 3);
        var typeThree = Promotion(1, priority: 10, targets: new PromotionTarget(PromotionScope.Type, 3));
        var couponOnly = Promotion(4, priority: 100, requiresCoupon: true);

        var best = PromotionMatching.BestMatch([typeThree, couponOnly], item);
        var onlyCoupon = PromotionMatching.BestMatch([couponOnly], item);

        Assert.IsNotNull(best);
        Assert.AreEqual(1, best.Id);
        Assert.IsNull(onlyCoupon);
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-6-24")]
    public async Task TC_PROMO_6_24_PromotionsService_drops_coupon_only_promotions()
    {
        var json = JsonSerializer.Serialize(
            new[] { Promotion(1, requiresCoupon: false), Promotion(4, priority: 100, requiresCoupon: true) },
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using var handler = new FakeHandler(json);
        using var http = new HttpClient(handler) { BaseAddress = new Uri("http://promotions-api/") };
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new PromotionsService(http, cache, NullLogger<PromotionsService>.Instance);

        var result = await service.GetActivePromotionsAsync();

        Assert.HasCount(1, result);
        Assert.AreEqual(1, result[0].Id);
        Assert.AreEqual(1, handler.Requests);
    }

    private sealed class FakeHandler(string json) : HttpMessageHandler
    {
        public int Requests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }
}
