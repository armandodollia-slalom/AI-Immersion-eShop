namespace eShop.Catalog.API.Model;

/// <summary>
/// Validates a catalog item body sent to the create and update endpoints.
/// Errors are keyed by field name in the shape <see cref="TypedResults.ValidationProblem"/> expects.
/// </summary>
public static class CatalogItemValidation
{
    public static Dictionary<string, string[]> Validate(CatalogItem item)
    {
        var errors = new Dictionary<string, string[]>();

        if (string.IsNullOrWhiteSpace(item.Name))
        {
            errors[nameof(CatalogItem.Name)] = ["The Name field is required."];
        }

        if (item.Price < 0)
        {
            errors[nameof(CatalogItem.Price)] = ["The Price field must be zero or greater."];
        }

        return errors;
    }
}
