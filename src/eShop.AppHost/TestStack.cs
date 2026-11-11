using System.Runtime.InteropServices;
using Aspire.Hosting.Docker;
using Aspire.Hosting.Publishing;
using Microsoft.Extensions.Configuration;

namespace eShop.AppHost;

/// <summary>
/// Docker Compose "test stack" used for reproducible, scenario-driven test runs.
/// Enabled with the <c>TestStack=true</c> configuration value (for example via <c>testing/teststack publish</c>).
/// Only compose-level customizations live here; the resource graph itself is shared with production.
/// </summary>
internal static class TestStack
{
    public const string EnvironmentName = "teststack";

    // Host name that resolves to the Docker host both from containers (Docker Desktop / host-gateway)
    // and from test browsers (mapped to 127.0.0.1, see playwright.teststack.config.ts). OIDC requires the
    // browser and the services to see the same identity URL, just like the external FQDN in Azure.
    public const string PublicHost = "host.docker.internal";

    // Host ports are published as compose interpolations (${WEBAPP_HOST_PORT:-18080}) so one generated file serves
    // several isolated copies of the stack ("slots"). The defaults are slot 0; testing/teststack --slot <n> exports
    // base + 1000*n for every variable. Names and defaults must match scripts/stack/config.json (a test checks the
    // generated compose file against it).
    public static readonly HostPort WebAppPort = new("WEBAPP_HOST_PORT", 18080);
    public static readonly HostPort IdentityApiPort = new("IDENTITY_API_HOST_PORT", 18081);
    public static readonly HostPort CatalogApiPort = new("CATALOG_API_HOST_PORT", 18082);
    public static readonly HostPort BasketApiPort = new("BASKET_API_HOST_PORT", 18083);
    public static readonly HostPort OrderingApiPort = new("ORDERING_API_HOST_PORT", 18084);
    public static readonly HostPort WebhooksApiPort = new("WEBHOOKS_API_HOST_PORT", 18085);
    public static readonly HostPort WebhooksClientPort = new("WEBHOOKSCLIENT_HOST_PORT", 18086);
    public static readonly HostPort MobileBffPort = new("MOBILE_BFF_HOST_PORT", 18087);
    public static readonly HostPort DashboardPort = new("DASHBOARD_HOST_PORT", 18888);
    public static readonly HostPort PostgresPort = new("POSTGRES_HOST_PORT", 18432);
    public static readonly HostPort RedisPort = new("REDIS_HOST_PORT", 18379);
    public static readonly HostPort RabbitMqPort = new("EVENTBUS_HOST_PORT", 18672);

    // Browser-facing URLs follow the slot's host ports, so Identity's client redirect URIs and the issuer match.
    public static string IdentityUrl => $"http://{PublicHost}:{IdentityApiPort}";
    public static string WebAppUrl => $"http://localhost:{WebAppPort}";
    public static string WebhooksClientUrl => $"http://localhost:{WebhooksClientPort}";

    private const string DashboardServiceName = EnvironmentName + "-dashboard";
    private const int DashboardContainerPort = 18888;

    public static bool IsEnabled(IConfiguration configuration) =>
        bool.TryParse(configuration["TestStack"], out var enabled) && enabled;

    public static IResourceBuilder<DockerComposeEnvironmentResource> AddTestStackEnvironment(this IDistributedApplicationBuilder builder) =>
        builder.AddDockerComposeEnvironment(EnvironmentName)
            .WithDashboard(dashboard => dashboard.WithHostPort(DashboardPort.Default))
            .ConfigureComposeFile(file =>
            {
                file.Name = "eshop-teststack";
                // The dashboard only takes a fixed host port; publish it through the slot variable too.
                if (file.Services.TryGetValue(DashboardServiceName, out var dashboard))
                {
                    dashboard.Ports = [$"{DashboardPort}:{DashboardContainerPort}"];
                }
            });

    /// <summary>
    /// Publishes a fixed host port for the resource's primary endpoint, lets the service reach the Docker host,
    /// applies browser-facing URL overrides and, for services with built-in seeders, turns the seeders off so
    /// scenario files own all data (EF migrations still run at startup, as in production).
    /// </summary>
    public static IResourceBuilder<T> WithTestStackService<T>(
        this IResourceBuilder<T> builder,
        HostPort? hostPort = null,
        int? containerPort = null,
        bool seeded = false,
        Dictionary<string, string>? env = null)
        where T : IComputeResource
    {
        if (builder.Resource.TryGetLastAnnotation<IProjectMetadata>(out _))
        {
            var platform = GetTargetPlatform(builder.ApplicationBuilder.Configuration["TestStackPlatform"]);
#pragma warning disable ASPIREPIPELINES003 // Container build options are in evaluation.
            builder.WithContainerBuildOptions(options => options.TargetPlatform = platform);
#pragma warning restore ASPIREPIPELINES003
        }

        return builder.PublishAsDockerComposeService((composeService, service) =>
        {
            if (hostPort is { } port)
            {
                var targetPort = containerPort?.ToString() ?? GetPrimaryTargetPort(service);
                service.Ports = [$"{port}:{targetPort}"];
            }

            service.ExtraHosts[PublicHost] = "host-gateway";
            service.Restart = "unless-stopped";

            if (seeded)
            {
                service.Environment["Seeding__Disabled"] = "true";
            }

            foreach (var (name, value) in env ?? [])
            {
                service.Environment[name] = value;
            }
        });
    }

    // Images run on the developer's machine, so build them for its architecture to avoid emulation.
    // TestStackPlatform=linux-amd64 reproduces the production (Azure Container Apps) architecture exactly.
#pragma warning disable ASPIREPIPELINES003
    private static ContainerTargetPlatform GetTargetPlatform(string? configured) =>
        configured switch
        {
            "linux-amd64" => ContainerTargetPlatform.LinuxAmd64,
            "linux-arm64" => ContainerTargetPlatform.LinuxArm64,
            null or "" => RuntimeInformation.OSArchitecture == Architecture.Arm64
                ? ContainerTargetPlatform.LinuxArm64
                : ContainerTargetPlatform.LinuxAmd64,
            _ => throw new InvalidOperationException($"Unsupported TestStackPlatform '{configured}'. Use linux-amd64 or linux-arm64."),
        };
#pragma warning restore ASPIREPIPELINES003

    // Project resources get their container port assigned by the compose publisher (exposed via HTTP_PORTS).
    private static string GetPrimaryTargetPort(Aspire.Hosting.Docker.Resources.ComposeNodes.Service service)
    {
        if (service.Environment.TryGetValue("HTTP_PORTS", out var httpPorts) && !string.IsNullOrEmpty(httpPorts))
        {
            return httpPorts.Split(';', ',')[0];
        }

        var existing = service.Ports.Concat(service.Expose).FirstOrDefault()
            ?? throw new InvalidOperationException($"Cannot determine the container port for compose service '{service.Name}'.");
        return existing.Split(':')[^1];
    }

    /// <summary>A host port published as <c>${Variable:-Default}</c> in the generated compose file.</summary>
    public readonly record struct HostPort(string Variable, int Default)
    {
        public override string ToString() => $"${{{Variable}:-{Default}}}";
    }
}
