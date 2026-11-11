using System.ComponentModel;

namespace eShop.Catalog.API.Model;

public record PaginationRequest(
    [property: Description("Number of items to return in a single page of results (0 to 100)")]
    [property: DefaultValue(10)]
    int PageSize = 10,

    [property: Description("The index of the page of results to return (0 or greater)")]
    [property: DefaultValue(0)]
    int PageIndex = 0
)
{
    public const int MaxPageSize = 100;

    /// <summary>
    /// Checks the paging values before they reach <c>Skip</c>/<c>Take</c>: a negative
    /// <see cref="PageSize"/> or <see cref="PageIndex"/> (or a page size above <see cref="MaxPageSize"/>)
    /// would otherwise fail in the database. Returns the errors keyed by property name, empty when valid.
    /// </summary>
    public Dictionary<string, string[]> Validate()
    {
        var errors = new Dictionary<string, string[]>();

        if (PageSize is < 0 or > MaxPageSize)
        {
            errors[nameof(PageSize)] = [$"PageSize must be between 0 and {MaxPageSize}."];
        }

        if (PageIndex < 0)
        {
            errors[nameof(PageIndex)] = ["PageIndex must be 0 or greater."];
        }

        return errors;
    }
}
