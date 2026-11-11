using Microsoft.Extensions.Caching.Memory;

namespace Promotions.API.Pricing;

/// <summary>
/// Holds the pricing candidates (<see cref="ActivePromotionsQuery"/> with coupon-only promotions included) in memory for
/// <see cref="Duration"/>, so <c>/evaluate</c> does not query the database on every cart change. Singleton.
/// </summary>
/// <remarks>
/// Rules are filtered again against <see cref="TimeProvider"/> on every read, so a promotion whose window closes while
/// it is cached is never applied. Admin publish, update and end calls <see cref="Invalidate"/>.
/// </remarks>
public sealed class PromotionCache(IMemoryCache cache, IServiceScopeFactory scopeFactory, TimeProvider timeProvider)
{
    /// <summary>
    /// The one place the cache key lives. Multi-tenancy (TENANT-*) adds the tenant id here so tenants never share an entry.
    /// </summary>
    public const string CacheKey = "active-promotions";

    public static readonly TimeSpan Duration = TimeSpan.FromSeconds(30);

    private readonly SemaphoreSlim _loadLock = new(1, 1);

    /// <summary>The active promotions (coupon-only included), ordered by priority descending then id ascending.</summary>
    public async Task<IReadOnlyList<PromotionRule>> GetActiveAsync(CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        if (!TryGetFresh(now, out var entry))
        {
            await _loadLock.WaitAsync(cancellationToken);
            try
            {
                now = timeProvider.GetUtcNow();
                if (!TryGetFresh(now, out entry))
                {
                    entry = await LoadAsync(now, cancellationToken);
                    cache.Set(CacheKey, entry, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = Duration });
                }
            }
            finally
            {
                _loadLock.Release();
            }
        }

        return entry.Rules.Where(rule => rule.StartsAt <= now && now < rule.EndsAt).ToList();
    }

    /// <summary>Drops the cached promotions so the next read loads them again.</summary>
    public void Invalidate() => cache.Remove(CacheKey);

    private bool TryGetFresh(DateTimeOffset now, out Entry entry)
    {
        if (cache.TryGetValue(CacheKey, out Entry? cached) && cached is not null && now - cached.LoadedAt < Duration && now >= cached.LoadedAt)
        {
            entry = cached;
            return true;
        }

        entry = null!;
        return false;
    }

    private async Task<Entry> LoadAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var query = scope.ServiceProvider.GetRequiredService<ActivePromotionsQuery>();
        var promotions = await query.ListAsync(includeCouponOnly: true, cancellationToken);
        return new Entry(now, promotions.Select(PromotionRule.From).ToList());
    }

    private sealed record Entry(DateTimeOffset LoadedAt, IReadOnlyList<PromotionRule> Rules);
}
