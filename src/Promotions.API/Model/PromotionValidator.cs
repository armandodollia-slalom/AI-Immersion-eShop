namespace Promotions.API.Model;

/// <summary>
/// The field rules of a promotion create or update. Errors are keyed by the camelCase JSON field name
/// (every target rule under <c>targets</c>, with the target index in the message), ready for <c>TypedResults.ValidationProblem</c>.
/// </summary>
public static class PromotionValidator
{
    public static Dictionary<string, string[]> Validate(PromotionRequest request)
    {
        var errors = new Dictionary<string, List<string>>();
        void Add(string field, string message)
        {
            if (!errors.TryGetValue(field, out var list))
            {
                errors[field] = list = [];
            }

            list.Add(message);
        }

        if (string.IsNullOrWhiteSpace(request.Name))
        {
            Add("name", "Name is required.");
        }
        else if (request.Name.Length > Promotion.NameMaxLength)
        {
            Add("name", $"Name must be at most {Promotion.NameMaxLength} characters.");
        }

        if (string.IsNullOrWhiteSpace(request.Description))
        {
            Add("description", "Description is required.");
        }
        else if (request.Description.Length > Promotion.DescriptionMaxLength)
        {
            Add("description", $"Description must be at most {Promotion.DescriptionMaxLength} characters.");
        }

        switch (request.Type)
        {
            case null:
                Add("type", "Type is required: PercentOff, AmountOffOrder or BuyXGetY.");
                break;
            case PromotionType.PercentOff:
                if (request.Value is not { } percent || percent <= 0 || percent > 100)
                {
                    Add("value", "A PercentOff value must be greater than 0 and at most 100.");
                }

                break;
            case PromotionType.AmountOffOrder:
                if (request.Value is not { } amount || amount <= 0)
                {
                    Add("value", "An AmountOffOrder value must be greater than 0.");
                }

                if (request.MinOrderTotal is null)
                {
                    Add("minOrderTotal", "MinOrderTotal is required for AmountOffOrder.");
                }

                break;
            case PromotionType.BuyXGetY:
                if (request.BuyQuantity is not >= 1)
                {
                    Add("buyQuantity", "BuyQuantity is required for BuyXGetY and must be at least 1.");
                }

                if (request.GetQuantity is not >= 1)
                {
                    Add("getQuantity", "GetQuantity is required for BuyXGetY and must be at least 1.");
                }

                break;
        }

        if (request.MinOrderTotal is < 0)
        {
            Add("minOrderTotal", "MinOrderTotal must not be negative.");
        }

        if (request.Targets is not { Count: > 0 })
        {
            Add("targets", "At least one target is required.");
        }
        else
        {
            for (var i = 0; i < request.Targets.Count; i++)
            {
                var target = request.Targets[i];
                if (target?.Scope is not { } scope)
                {
                    Add("targets", $"Target {i}: Scope is required: All, Brand, Type or Product.");
                }
                else if (scope == PromotionScope.All && target.TargetId is not null)
                {
                    Add("targets", $"Target {i}: TargetId must be null when scope is All.");
                }
                else if (scope != PromotionScope.All && target.TargetId is null)
                {
                    Add("targets", $"Target {i}: TargetId is required when scope is {scope}.");
                }
            }
        }

        if (request.StartsAt is null)
        {
            Add("startsAt", "StartsAt is required.");
        }

        if (request.EndsAt is null)
        {
            Add("endsAt", "EndsAt is required.");
        }
        else if (request.StartsAt is not null && request.EndsAt <= request.StartsAt)
        {
            Add("endsAt", "EndsAt must be later than StartsAt.");
        }

        return errors.ToDictionary(e => e.Key, e => e.Value.ToArray());
    }

    /// <summary>Copies a valid request onto the promotion. Fields a type ignores are cleared (Value 0 for BuyXGetY, no quantities for the others).</summary>
    public static void Apply(PromotionRequest request, Promotion promotion)
    {
        var type = request.Type!.Value;
        promotion.Name = request.Name!.Trim();
        promotion.Description = request.Description!.Trim();
        promotion.Type = type;
        promotion.Value = type == PromotionType.BuyXGetY ? 0m : request.Value!.Value;
        promotion.MinOrderTotal = request.MinOrderTotal;
        promotion.BuyQuantity = type == PromotionType.BuyXGetY ? request.BuyQuantity : null;
        promotion.GetQuantity = type == PromotionType.BuyXGetY ? request.GetQuantity : null;
        promotion.StartsAt = request.StartsAt!.Value;
        promotion.EndsAt = request.EndsAt!.Value;
        promotion.Priority = request.Priority;
        promotion.IsStackable = request.IsStackable;
        promotion.RequiresCoupon = request.RequiresCoupon;

        promotion.Targets.Clear();
        promotion.Targets.AddRange(request.Targets!.Select(t => new PromotionTarget { Scope = t.Scope!.Value, TargetId = t.TargetId }));
    }
}
