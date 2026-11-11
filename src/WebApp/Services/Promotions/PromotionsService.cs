using eShop.WebAppComponents.Promotions;
using Microsoft.Extensions.Caching.Memory;

namespace eShop.WebApp.Services.Promotions;

/// <summary>
/// Reads the active promotions from Promotions.API. Never throws: when the service is down or slow the
/// storefront shows normal prices, so failures return an empty list.
/// </summary>
/// <remarks>
/// The banner and the page both ask for promotions during one request. The cache holds the in-flight task,
/// so they share a single call, and a failure is cached briefly so an outage costs at most one 2s timeout
/// per page load rather than one per caller.
/// </remarks>
public class PromotionsService(HttpClient httpClient, IMemoryCache cache, ILogger<PromotionsService> logger)
{
    public const string ActiveCacheKey = "promotions:active";

    private static readonly TimeSpan CacheDuration = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan FailureCacheDuration = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(2);

    public Task<IReadOnlyList<ActivePromotion>> GetActivePromotionsAsync()
    {
        if (cache.TryGetValue(ActiveCacheKey, out Task<IReadOnlyList<ActivePromotion>>? cached) && cached is not null)
        {
            return cached;
        }

        var load = LoadAsync();
        cache.Set(ActiveCacheKey, load, CacheDuration);
        return load;
    }

    public void InvalidateActive() => cache.Remove(ActiveCacheKey);

    private async Task<IReadOnlyList<ActivePromotion>> LoadAsync()
    {
        try
        {
            // The shared resilience handler retries and has a long total timeout, so cap the whole call here.
            using var cts = new CancellationTokenSource(RequestTimeout);
            var promotions = await httpClient.GetFromJsonAsync<List<ActivePromotion>>("api/promotions/active", cts.Token) ?? [];
            return promotions.Where(p => !p.RequiresCoupon).ToList();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not load active promotions; showing regular prices");
            IReadOnlyList<ActivePromotion> empty = [];
            _ = cache.Set(ActiveCacheKey, Task.FromResult(empty), FailureCacheDuration);
            return empty;
        }
    }
}
