using eShop.WebAppComponents.Promotions;
using Microsoft.Extensions.Caching.Memory;

namespace eShop.WebApp.Services.Promotions;

/// <summary>
/// Reads the active promotions from Promotions.API. Never throws: when the service is down or slow the
/// storefront shows normal prices, so failures return an empty list.
/// </summary>
public class PromotionsService(HttpClient httpClient, IMemoryCache cache, ILogger<PromotionsService> logger)
{
    public const string ActiveCacheKey = "promotions:active";

    private static readonly TimeSpan CacheDuration = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(2);

    public async Task<IReadOnlyList<ActivePromotion>> GetActivePromotionsAsync()
    {
        if (cache.TryGetValue(ActiveCacheKey, out IReadOnlyList<ActivePromotion>? cached) && cached is not null)
        {
            return cached;
        }

        try
        {
            // The shared resilience handler retries and has a long total timeout, so cap the whole call here.
            using var cts = new CancellationTokenSource(RequestTimeout);
            var promotions = await httpClient.GetFromJsonAsync<List<ActivePromotion>>("api/promotions/active", cts.Token) ?? [];
            IReadOnlyList<ActivePromotion> result = promotions.Where(p => !p.RequiresCoupon).ToList();
            cache.Set(ActiveCacheKey, result, CacheDuration);
            return result;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not load active promotions; showing regular prices");
            return [];
        }
    }

    public void InvalidateActive() => cache.Remove(ActiveCacheKey);
}
