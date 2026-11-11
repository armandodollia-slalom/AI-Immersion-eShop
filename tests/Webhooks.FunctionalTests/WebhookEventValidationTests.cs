using System.Net;
using System.Net.Http.Json;
using Asp.Versioning;
using Asp.Versioning.Http;

namespace eShop.Webhooks.FunctionalTests;

[Trait("Story", "BUG-16")]
public sealed class WebhookEventValidationTests(WebhooksApiFixture fixture) : IClassFixture<WebhooksApiFixture>
{
    private HttpClient CreateClient(string userId)
    {
        var handler = new ApiVersionHandler(new QueryStringApiVersionWriter(), new ApiVersion(1.0));
        var client = fixture.CreateDefaultClient(handler);
        client.DefaultRequestHeaders.Add("X-Test-User", userId);
        return client;
    }

    private static WebhookSubscriptionRequest Request(string token, string eventName) => new()
    {
        Url = "http://webhooksclient:8080/webhook-received",
        GrantUrl = "http://webhooksclient:8080/check",
        Token = token,
        Event = eventName
    };

    private static async Task<List<WebhookSubscription>> ListAsync(HttpClient client) =>
        (await client.GetFromJsonAsync<List<WebhookSubscription>>(
            "/api/webhooks/", TestContext.Current.CancellationToken))!;

    [Fact]
    [Trait("TestCase", "TC-BUG-16-01")]
    public async Task TC_BUG_16_01_Numeric_event_99_is_rejected_and_not_stored()
    {
        using var client = CreateClient($"alice-{Guid.NewGuid():N}");
        var before = await ListAsync(client);

        var response = await client.PostAsJsonAsync(
            "/api/webhooks/", Request("numeric", "99"), TestContext.Current.CancellationToken);
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("99 is invalid event name", body);
        Assert.Null(response.Headers.Location);
        var after = await ListAsync(client);
        Assert.Equal(before.Count, after.Count);
        Assert.DoesNotContain(after, s => s.Token == "numeric");
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-16-02")]
    public async Task TC_BUG_16_02_Valid_event_name_OrderShipped_is_accepted()
    {
        using var client = CreateClient($"alice-{Guid.NewGuid():N}");

        var response = await client.PostAsJsonAsync(
            "/api/webhooks/", Request("valid-name", "OrderShipped"), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.NotNull(response.Headers.Location);
        Assert.Matches(@"/api/webhooks/\d+", response.Headers.Location!.ToString());
        var list = await ListAsync(client);
        var created = Assert.Single(list, s => s.Token == "valid-name");
        Assert.Equal(WebhookType.OrderShipped, created.Type);
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-16-03")]
    public async Task TC_BUG_16_03_Numeric_string_for_defined_member_is_accepted()
    {
        using var client = CreateClient($"alice-{Guid.NewGuid():N}");

        var response = await client.PostAsJsonAsync(
            "/api/webhooks/", Request("numeric-defined", "1"), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.NotNull(response.Headers.Location);
        Assert.Matches(@"/api/webhooks/\d+", response.Headers.Location!.ToString());
        var list = await ListAsync(client);
        var created = Assert.Single(list, s => s.Token == "numeric-defined");
        Assert.Equal(WebhookType.CatalogItemPriceChange, created.Type);
    }

    [Fact]
    [Trait("TestCase", "TC-BUG-16-04")]
    public async Task TC_BUG_16_04_Unknown_event_name_is_rejected()
    {
        using var client = CreateClient($"alice-{Guid.NewGuid():N}");

        var response = await client.PostAsJsonAsync(
            "/api/webhooks/", Request("unknown-name", "NotAnEvent"), TestContext.Current.CancellationToken);
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("NotAnEvent is invalid event name", body);
        var list = await ListAsync(client);
        Assert.DoesNotContain(list, s => s.Token == "unknown-name");
    }
}
