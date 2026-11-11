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

        if (item.Name is null)
        {
            errors[nameof(CatalogItem.Name)] = ["The Name field is required."];
        }

        return errors;
    }
}
