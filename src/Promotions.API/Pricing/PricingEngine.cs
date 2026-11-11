namespace Promotions.API.Pricing;

/// <summary>
/// Works out the best discounts for a cart. Pure: no database, no clock, no services, so the same input always gives
/// the same result (PROMO-5 re-checks orders with it and the unit tests run it on its own).
/// </summary>
/// <remarks>
/// The algorithm (PROMO-3):
/// <list type="number">
/// <item>Candidates: coupon-only promotions count only when the coupon check is <c>Applied</c> for their id.</item>
/// <item>Line discounts: among the non-stackable matches (every <c>BuyXGetY</c> and non-stackable <c>PercentOff</c>)
/// the largest discount wins, ties go to the higher priority, then the lower id. Stackable <c>PercentOff</c> matches
/// then apply, in turn, to what is left of the line.</item>
/// <item>Order level: the best non-stackable <c>AmountOffOrder</c> whose minimum is met by the subtotal after line
/// discounts, then any stackable ones (fixed amounts last), each split across its lines in proportion to their
/// remaining totals, with the rounding remainder on the largest line.</item>
/// <item>Each part is rounded to 2 decimals (<see cref="MidpointRounding.ToEven"/>) and a line's discount never exceeds
/// its total (the rule Ordering's <c>OrderItem</c> enforces).</item>
/// </list>
/// </remarks>
public static class PricingEngine
{
    public static PricingResult Evaluate(IReadOnlyList<PromotionRule> candidates, IReadOnlyList<EvaluateLine> lines, CouponCheck coupon)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        ArgumentNullException.ThrowIfNull(lines);
        ArgumentNullException.ThrowIfNull(coupon);

        var eligible = candidates.Where(rule => IsEligible(rule, coupon)).ToList();
        var states = lines.Select(line => new LineState(line)).ToList();

        foreach (var state in states)
        {
            ApplyLinePromotions(state, eligible);
        }

        var nextThreshold = ApplyOrderPromotions(states, eligible);

        var pricedLines = states
            .Select(state => new PricedLine(
                state.Line.ProductId,
                state.LineTotal,
                state.Discount,
                state.Parts.Select(part => part.Rule.Id).Distinct().Order().ToList()))
            .ToList();

        var appliedPromotions = states
            .SelectMany(state => state.Parts)
            .GroupBy(part => part.Rule.Id)
            .OrderBy(group => group.Key)
            .Select(group =>
            {
                var rule = group.First().Rule;
                return new AppliedPromotion(rule.Id, rule.Name, rule.BadgeLabel, group.Sum(part => part.Amount));
            })
            .Where(applied => applied.Savings > 0)
            .ToList();

        var subtotal = pricedLines.Sum(line => line.LineTotal);
        var totalDiscount = pricedLines.Sum(line => line.Discount);

        return new PricingResult(
            subtotal,
            totalDiscount,
            subtotal - totalDiscount,
            pricedLines,
            appliedPromotions,
            CouponResult.From(coupon),
            nextThreshold);
    }

    /// <summary>Rounds a money amount the one way pricing does: 2 decimals, banker's rounding.</summary>
    public static decimal RoundMoney(decimal amount) => Math.Round(amount, 2, MidpointRounding.ToEven);

    /// <summary>The unrounded discount a line promotion gives a line: <c>PercentOff</c> on the line total, <c>BuyXGetY</c> free units × unit price.</summary>
    public static decimal LineDiscount(PromotionRule rule, EvaluateLine line) => rule.Type switch
    {
        PromotionType.PercentOff => line.UnitPrice * line.Quantity * rule.Value / 100m,
        PromotionType.BuyXGetY => FreeUnits(rule, line.Quantity) * line.UnitPrice,
        _ => 0m,
    };

    /// <summary><c>floor(quantity / (buy + get)) * get</c>; 0 for a malformed rule.</summary>
    public static int FreeUnits(PromotionRule rule, int quantity)
    {
        var buy = rule.BuyQuantity ?? 0;
        var get = rule.GetQuantity ?? 0;
        if (buy < 0 || get <= 0 || quantity <= 0)
        {
            return 0;
        }

        return quantity / (buy + get) * get;
    }

    private static bool IsEligible(PromotionRule rule, CouponCheck coupon) =>
        !rule.RequiresCoupon || (coupon.Status == CouponStatus.Applied && coupon.PromotionId == rule.Id);

    // BuyXGetY is non-stackable only (open question resolved in the story).
    private static bool IsExclusive(PromotionRule rule) => rule.Type == PromotionType.BuyXGetY || !rule.IsStackable;

    private static void ApplyLinePromotions(LineState state, List<PromotionRule> eligible)
    {
        var matching = eligible
            .Where(rule => (rule.Type is PromotionType.PercentOff or PromotionType.BuyXGetY) && rule.Matches(state.Line))
            .ToList();

        var best = matching
            .Where(IsExclusive)
            .Select(rule => (Rule: rule, Amount: Math.Min(RoundMoney(LineDiscount(rule, state.Line)), state.Remaining)))
            .Where(candidate => candidate.Amount > 0)
            .OrderByDescending(candidate => candidate.Amount)
            .ThenByDescending(candidate => candidate.Rule.Priority)
            .ThenBy(candidate => candidate.Rule.Id)
            .FirstOrDefault();

        if (best.Rule is not null)
        {
            state.Add(best.Rule, best.Amount);
        }

        foreach (var rule in matching.Where(rule => !IsExclusive(rule)).OrderByDescending(rule => rule.Priority).ThenBy(rule => rule.Id))
        {
            state.Add(rule, Math.Min(RoundMoney(state.Remaining * rule.Value / 100m), state.Remaining));
        }
    }

    /// <summary>Applies the order-level promotions and returns the closest unmet threshold, or null.</summary>
    private static NextThreshold? ApplyOrderPromotions(List<LineState> states, List<PromotionRule> eligible)
    {
        // Every threshold is measured against the subtotal after line discounts, before any order-level discount.
        var orderRules = eligible
            .Where(rule => rule.Type == PromotionType.AmountOffOrder)
            .Select(rule =>
            {
                var lines = states.Where(state => rule.Matches(state.Line)).ToList();
                var qualifying = lines.Sum(state => state.Remaining);
                return (Rule: rule, Lines: lines, Qualifying: qualifying, Minimum: rule.MinOrderTotal ?? 0m);
            })
            .ToList();

        var met = orderRules.Where(o => o.Lines.Count > 0 && o.Minimum <= o.Qualifying).ToList();

        var best = met
            .Where(o => !o.Rule.IsStackable)
            .OrderByDescending(o => Math.Min(o.Rule.Value, o.Qualifying))
            .ThenByDescending(o => o.Rule.Priority)
            .ThenBy(o => o.Rule.Id)
            .Take(1);

        var stackable = met
            .Where(o => o.Rule.IsStackable)
            .OrderByDescending(o => o.Rule.Priority)
            .ThenBy(o => o.Rule.Id);

        foreach (var order in best.Concat(stackable))
        {
            Distribute(order.Rule, order.Lines, order.Rule.Value);
        }

        return orderRules
            .Where(o => o.Minimum > o.Qualifying)
            .OrderBy(o => o.Minimum - o.Qualifying)
            .ThenByDescending(o => o.Rule.Priority)
            .ThenBy(o => o.Rule.Id)
            .Select(o => new NextThreshold(o.Rule.Id, o.Minimum, o.Minimum - o.Qualifying, o.Rule.Value))
            .FirstOrDefault();
    }

    /// <summary>
    /// Splits <paramref name="amount"/> across <paramref name="lines"/> in proportion to what is left of each, so the
    /// parts add up exactly to the amount (capped at what is left) and no line goes below 0. The rounding remainder goes
    /// to the largest line first.
    /// </summary>
    private static void Distribute(PromotionRule rule, List<LineState> lines, decimal amount)
    {
        var remaining = lines.Sum(state => state.Remaining);
        amount = Math.Min(RoundMoney(amount), remaining);
        if (amount <= 0)
        {
            return;
        }

        var shares = lines
            .Select(state => Math.Clamp(RoundMoney(amount * state.Remaining / remaining), 0m, state.Remaining))
            .ToArray();

        var difference = amount - shares.Sum();
        var largestFirst = Enumerable.Range(0, lines.Count)
            .OrderByDescending(i => lines[i].Remaining)
            .ThenBy(i => i);

        foreach (var i in largestFirst)
        {
            if (difference == 0)
            {
                break;
            }

            var adjustment = difference > 0
                ? Math.Min(difference, lines[i].Remaining - shares[i])
                : -Math.Min(-difference, shares[i]);
            shares[i] += adjustment;
            difference -= adjustment;
        }

        for (var i = 0; i < lines.Count; i++)
        {
            lines[i].Add(rule, shares[i]);
        }
    }

    private sealed class LineState(EvaluateLine line)
    {
        public EvaluateLine Line { get; } = line;

        public decimal LineTotal { get; } = line.UnitPrice * line.Quantity;

        public List<(PromotionRule Rule, decimal Amount)> Parts { get; } = [];

        public decimal Discount => Math.Min(Parts.Sum(part => part.Amount), LineTotal);

        public decimal Remaining => LineTotal - Discount;

        public void Add(PromotionRule rule, decimal amount)
        {
            amount = Math.Min(amount, Remaining);
            if (amount > 0)
            {
                Parts.Add((rule, amount));
            }
        }
    }
}
