using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using Asp.Versioning;
using Asp.Versioning.Http;
using Microsoft.AspNetCore.Mvc.Testing;

namespace eShop.Catalog.FunctionalTests;

[Trait("Story", "BUG-13")]
public sealed class CatalogItemValidationTests : IClassFixture<CatalogApiFixture>
{
    private readonly WebApplicationFactory<Program> _factory;

    public CatalogItemValidationTests(CatalogApiFixture fixture) => _factory = fixture;

    private HttpClient Client(double version) =>
        _factory.CreateDefaultClient(new ApiVersionHandler(new QueryStringApiVersionWriter(), new ApiVersion(version)));

    private static object Body(string name, decimal price, int? id = null) => new
    {
        id = id ?? 0,
        name,
        description = "Edge",
        price,
        pictureFileName = "1.webp",
        catalogTypeId = 1,
        catalogBrandId = 1,
        availableStock = 5,
        restockThreshold = 1,
        maxStockThreshold = 10
    };

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<JsonElement> ReadJson(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct)).RootElement.Clone();

    private static async Task AssertValidationProblem(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var json = await ReadJson(response);
        Assert.Equal(JsonValueKind.Object, json.GetProperty("errors").ValueKind);
    }

    private async Task<JsonElement> GetItem(HttpClient client, int id)
    {
        var response = await client.GetAsync($"/api/catalog/items/{id}", Ct);
        response.EnsureSuccessStatusCode();
        return await ReadJson(response);
    }

    private async Task<JsonElement> GetAll(HttpClient client)
    {
        var response = await client.GetAsync("/api/catalog/items?pageIndex=0&pageSize=1000", Ct);
        response.EnsureSuccessStatusCode();
        return await ReadJson(response);
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-01")]
    public async Task TC_BUG_13_01_Create_with_empty_name_returns_400()
    {
        var response = await Client(2.0).PostAsJsonAsync("/api/catalog/items", Body("", 10), Ct);
        await AssertValidationProblem(response);
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-02")]
    public async Task TC_BUG_13_02_Create_with_negative_price_returns_400()
    {
        var response = await Client(2.0).PostAsJsonAsync("/api/catalog/items", Body("Edge Negative Price", -5), Ct);
        await AssertValidationProblem(response);
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-03")]
    public async Task TC_BUG_13_03_Rejected_create_stores_no_item()
    {
        var client = Client(2.0);
        var before = (await GetAll(client)).GetProperty("count").GetInt64();

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/catalog/items", Body("", 10), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/catalog/items", Body("Edge Negative Price", -5), Ct)).StatusCode);

        var after = await GetAll(client);
        Assert.Equal(before, after.GetProperty("count").GetInt64());
        foreach (var item in after.GetProperty("data").EnumerateArray())
        {
            Assert.False(string.IsNullOrEmpty(item.GetProperty("name").GetString()));
            Assert.True(item.GetProperty("price").GetDecimal() >= 0);
        }
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-04")]
    public async Task TC_BUG_13_04_V2_update_with_empty_name_returns_400_and_leaves_item_unchanged()
    {
        var client = Client(2.0);
        var before = await GetItem(client, 1);

        var response = await client.PutAsJsonAsync("/api/catalog/items/1", Body("", 10, 1), Ct);

        await AssertValidationProblem(response);
        var after = await GetItem(client, 1);
        Assert.Equal(before.GetProperty("name").GetString(), after.GetProperty("name").GetString());
        Assert.Equal(before.GetProperty("price").GetDecimal(), after.GetProperty("price").GetDecimal());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-05")]
    public async Task TC_BUG_13_05_V2_update_with_negative_price_returns_400_and_leaves_item_unchanged()
    {
        var client = Client(2.0);
        var before = await GetItem(client, 1);

        var response = await client.PutAsJsonAsync("/api/catalog/items/1", Body(before.GetProperty("name").GetString()!, -5, 1), Ct);

        await AssertValidationProblem(response);
        var after = await GetItem(client, 1);
        Assert.Equal(before.GetProperty("price").GetDecimal(), after.GetProperty("price").GetDecimal());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-06")]
    public async Task TC_BUG_13_06_V1_update_with_empty_name_returns_400()
    {
        var v2 = Client(2.0);
        var before = await GetItem(v2, 1);

        var response = await Client(1.0).PutAsJsonAsync("/api/catalog/items", Body("", 10, 1), Ct);

        await AssertValidationProblem(response);
        var after = await GetItem(v2, 1);
        Assert.Equal(before.GetProperty("name").GetString(), after.GetProperty("name").GetString());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-07")]
    public async Task TC_BUG_13_07_Valid_create_still_returns_201()
    {
        var client = Client(2.0);
        var response = await client.PostAsJsonAsync("/api/catalog/items", Body("Edge Valid Boot", 25, 20013), Ct);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var location = response.Headers.Location!.ToString();
        Assert.StartsWith("/api/catalog/items/", location);
        var item = await ReadJson(await client.GetAsync(location, Ct));
        Assert.Equal("Edge Valid Boot", item.GetProperty("name").GetString());
        Assert.Equal(25m, item.GetProperty("price").GetDecimal());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-08")]
    public async Task TC_BUG_13_08_Create_with_price_zero_returns_201()
    {
        var client = Client(2.0);
        var response = await client.PostAsJsonAsync("/api/catalog/items", Body("Edge Zero Price", 0, 20014), Ct);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var item = await ReadJson(await client.GetAsync(response.Headers.Location!, Ct));
        Assert.Equal(0m, item.GetProperty("price").GetDecimal());
        Assert.Equal("Edge Zero Price", item.GetProperty("name").GetString());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-09")]
    public async Task TC_BUG_13_09_Create_with_price_just_below_zero_returns_400()
    {
        var client = Client(2.0);
        var response = await client.PostAsJsonAsync("/api/catalog/items", Body("Edge Tiny Negative", -0.01m), Ct);

        await AssertValidationProblem(response);
        var all = await GetAll(client);
        Assert.DoesNotContain(all.GetProperty("data").EnumerateArray(), i => i.GetProperty("name").GetString() == "Edge Tiny Negative");
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-10")]
    public async Task TC_BUG_13_10_Create_with_whitespace_name_returns_400()
    {
        var client = Client(2.0);
        var response = await client.PostAsJsonAsync("/api/catalog/items", Body("   ", 10), Ct);

        await AssertValidationProblem(response);
        var all = await GetAll(client);
        Assert.DoesNotContain(all.GetProperty("data").EnumerateArray(), i => string.IsNullOrWhiteSpace(i.GetProperty("name").GetString()));
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-11")]
    public async Task TC_BUG_13_11_V1_update_with_negative_price_returns_400()
    {
        var v2 = Client(2.0);
        var before = await GetItem(v2, 1);

        var response = await Client(1.0).PutAsJsonAsync("/api/catalog/items", Body(before.GetProperty("name").GetString()!, -5, 1), Ct);

        await AssertValidationProblem(response);
        var after = await GetItem(v2, 1);
        Assert.Equal(before.GetProperty("price").GetDecimal(), after.GetProperty("price").GetDecimal());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-12")]
    public async Task TC_BUG_13_12_Valid_v2_update_succeeds_and_persists()
    {
        var client = Client(2.0);
        var name = (await GetItem(client, 1)).GetProperty("name").GetString()!;

        var response = await client.PutAsJsonAsync("/api/catalog/items/1", Body(name, 12.5m, 1), Ct);

        Assert.True(response.IsSuccessStatusCode, $"Status was {response.StatusCode}");
        Assert.Equal(12.5m, (await GetItem(client, 1)).GetProperty("price").GetDecimal());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-13")]
    public async Task TC_BUG_13_13_V2_update_with_price_zero_succeeds()
    {
        var client = Client(2.0);
        var name = (await GetItem(client, 1)).GetProperty("name").GetString()!;

        var response = await client.PutAsJsonAsync("/api/catalog/items/1", Body(name, 0m, 1), Ct);

        Assert.True(response.IsSuccessStatusCode, $"Status was {response.StatusCode}");
        Assert.Equal(0m, (await GetItem(client, 1)).GetProperty("price").GetDecimal());
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-13-14")]
    public async Task TC_BUG_13_14_Valid_v1_update_succeeds_and_persists()
    {
        var v2 = Client(2.0);
        var name = (await GetItem(v2, 1)).GetProperty("name").GetString()!;

        var response = await Client(1.0).PutAsJsonAsync("/api/catalog/items", Body(name, 12.5m, 1), Ct);

        Assert.True(response.IsSuccessStatusCode, $"Status was {response.StatusCode}");
        Assert.Equal(12.5m, (await GetItem(v2, 1)).GetProperty("price").GetDecimal());
    }
}
