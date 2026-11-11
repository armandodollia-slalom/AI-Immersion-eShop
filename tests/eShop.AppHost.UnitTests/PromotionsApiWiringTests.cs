using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System.Reflection;

namespace eShop.AppHost.UnitTests;

/// <summary>
/// Resource model of the real AppHost (src/eShop.AppHost/AppHost.cs) for the promotions-api registration (PROMO-1).
/// The model is built without starting any resource.
/// </summary>
[TestClass]
[TestCategory("PROMO-1")]
public class PromotionsApiWiringTests
{
    public TestContext TestContext { get; set; } = null!;

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-1-01")]
    public async Task TC_PROMO_1_01_PromotionsApiReferencesAndWaitsForEventBusAndPromotionsDb()
    {
        await using var builder = await CreateModelAsync();

        var promotions = Find<IResource>(builder, "promotions-api");

        var references = ReferencedNames(promotions);
        CollectionAssert.Contains(references, "eventbus");
        CollectionAssert.Contains(references, "promotionsdb");

        var waits = promotions.Annotations.OfType<WaitAnnotation>().Select(a => a.Resource.Name).ToArray();
        CollectionAssert.Contains(waits, "eventbus");
        CollectionAssert.Contains(waits, "promotionsdb");

        var database = Find<PostgresDatabaseResource>(builder, "promotionsdb");
        var postgres = Find<PostgresServerResource>(builder, "postgres");
        Assert.AreSame(postgres, database.Parent);
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-1-02")]
    public async Task TC_PROMO_1_02_PromotionsApiHasHttpHealthCheckOnHealth()
    {
        await using var builder = await CreateModelAsync();

        var promotions = Find<IResource>(builder, "promotions-api");

        var healthChecks = promotions.Annotations.OfType<HealthCheckAnnotation>().ToArray();
        Assert.HasCount(1, healthChecks);
        // WithHttpHealthCheck registers a HealthCheckRegistration under the annotation's key; the check it builds
        // (an endpoint URI check) carries the configured path, which is read from the instance.
        var options = builder.Services.BuildServiceProvider().GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value;
        var registration = options.Registrations.Single(r => r.Name == healthChecks[0].Key);
        var check = registration.Factory(builder.Services.BuildServiceProvider());
        var members = check.GetType().GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)
            .Select(f => f.GetValue(check))
            .Concat(check.GetType().GetProperties(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)
                .Where(p => p.GetIndexParameters().Length == 0).Select(p => p.GetValue(check)))
            .OfType<string>()
            .ToArray();
        CollectionAssert.Contains(members, "/health", $"health check {check.GetType().Name} has no path '/health' (string members: {string.Join(", ", members)})");
        Assert.IsFalse(members.Any(m => m.StartsWith('/') && m != "/health"), "the health check has another path than /health");

        var probe = promotions.Annotations.OfType<EndpointAnnotation>().Count();
        Assert.IsGreaterThan(0, probe, "promotions-api has no endpoint for the health check");
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-1-03")]
    public async Task TC_PROMO_1_03_PromotionsApiGetsIdentityUrlEnvironmentVariable()
    {
        await using var builder = await CreateModelAsync();

        var promotionsValue = await IdentityUrlAsync(builder, Find<IResource>(builder, "promotions-api"));
        var orderingValue = await IdentityUrlAsync(builder, Find<IResource>(builder, "ordering-api"));

        Assert.IsNotNull(promotionsValue);
        var endpoint = promotionsValue as EndpointReference;
        Assert.IsNotNull(endpoint, $"Identity__Url is {promotionsValue.GetType().Name}, not an endpoint reference");
        Assert.AreEqual("identity-api", endpoint.Resource.Name);
        Assert.AreEqual(orderingValue, promotionsValue);
    }

    [TestMethod]
    [TestProperty("TestCase", "TC-PROMO-1-04")]
    public async Task TC_PROMO_1_04_WebAppAndOrderingApiReferencePromotionsApi()
    {
        await using var builder = await CreateModelAsync();

        CollectionAssert.Contains(ReferencedNames(Find<IResource>(builder, "webapp")), "promotions-api");
        CollectionAssert.Contains(ReferencedNames(Find<IResource>(builder, "ordering-api")), "promotions-api");
    }

    private static string[] ReferencedNames(IResource resource) =>
        resource.Annotations.OfType<ResourceRelationshipAnnotation>()
            .Where(a => a.Type == "Reference")
            .Select(a => a.Resource.Name)
            .ToArray();

    private static T Find<T>(IDistributedApplicationTestingBuilder builder, string name) where T : IResource =>
        builder.Resources.OfType<T>().Single(r => r.Name == name);

    // The value is an endpoint reference that only resolves once the Identity endpoint is allocated (not in a model-only
    // build), so the value itself, not its resolved text, is compared.
    private async Task<object?> IdentityUrlAsync(IDistributedApplicationTestingBuilder builder, IResource resource)
    {
        var context = new EnvironmentCallbackContext(builder.ExecutionContext, resource, cancellationToken: TestContext.CancellationToken);
        foreach (var callback in resource.Annotations.OfType<EnvironmentCallbackAnnotation>())
        {
            await callback.Callback(context);
        }

        Assert.IsTrue(context.EnvironmentVariables.TryGetValue("Identity__Url", out var value), $"{resource.Name} has no Identity__Url");
        return value;
    }

    private Task<IDistributedApplicationTestingBuilder> CreateModelAsync() =>
        DistributedApplicationTestingBuilder.CreateAsync(typeof(Program), TestContext.CancellationToken);
}
