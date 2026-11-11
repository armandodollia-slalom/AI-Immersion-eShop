namespace Promotions.API.Services;

/// <summary>
/// Stand-in until PROMO-4 ships the real coupon check: every request is treated as having no coupon, so coupon-only
/// promotions never apply.
/// </summary>
public sealed class NotProvidedCouponValidator : ICouponValidator
{
    public Task<CouponCheck> ValidateAsync(string? code, string buyerId, decimal? orderSubtotal, CancellationToken cancellationToken) =>
        Task.FromResult(CouponCheck.NotProvided);
}
