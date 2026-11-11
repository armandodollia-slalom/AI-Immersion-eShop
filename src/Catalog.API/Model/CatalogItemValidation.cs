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

    /// <summary>
    /// Adds an error for each brand or type id that does not exist, so unknown ids are rejected
    /// with 400 instead of failing the foreign key on save.
    /// </summary>
    public static async Task AddReferenceErrorsAsync(CatalogItem item, CatalogContext context, Dictionary<string, string[]> errors)
    {
        if (!await context.CatalogBrands.AnyAsync(b => b.Id == item.CatalogBrandId))
        {
            errors[nameof(CatalogItem.CatalogBrandId)] = [$"Catalog brand with id {item.CatalogBrandId} does not exist."];
        }

        if (!await context.CatalogTypes.AnyAsync(t => t.Id == item.CatalogTypeId))
        {
            errors[nameof(CatalogItem.CatalogTypeId)] = [$"Catalog type with id {item.CatalogTypeId} does not exist."];
        }
    }
}
