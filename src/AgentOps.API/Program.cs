using AgentOps.API;
using AgentOps.Data.Reporting;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();

builder.AddNpgsqlDbContext<AgentOpsContext>(AgentOpsContext.ConnectionName);
builder.Services.AddMigration<AgentOpsContext>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<AgentOpsReports>();
builder.Services.AddProblemDetails();

builder.Services.AddApiVersioning(options => options.ReportApiVersions = true);

var app = builder.Build();

app.MapDefaultEndpoints();

// The dashboard is a static page over the read-only API below; the service has no external ingress.
app.UseDefaultFiles();
app.UseStaticFiles();

app.NewVersionedApi("AgentOps").MapAgentOpsApiV1();

app.Run();
