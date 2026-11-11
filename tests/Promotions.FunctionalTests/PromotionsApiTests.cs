using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Npgsql;

namespace eShop.Promotions.FunctionalTests;

/// <summary>
/// PROMO-1 functional cases: the real Promotions.API in-process against a real Postgres database (seeding on unless a case says otherwise).
/// Updated for PROMO-2, which changes PROMO-1 behaviour on purpose: the PromotionRuleModel migration and the epic seed
/// data, coupon-only promotions left out of /active, and the public /active shape (no status; description, value,
/// badgeLabel and targets added).
/// The cases that need a token issued by Identity.API (the Identity cases of the plan) run on the test stack in
/// e2e/teststack/promo-1-promotions.spec.ts.
/// </summary>
[Collection(InfrastructureCollection.Name)]
[Trait("Story", "PROMO-1")]
public sealed class PromotionsApiTests(InfrastructureFixture infrastructure)
{
    private const string Active = "/api/promotions/active?api-version=1.0";
    private const string List = "/api/promotions?api-version=1.0";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] SeededNamesByPriority =
        ["Fall Hiking Sale", "$10 off orders over $150", "Buy 2 Get 1 Free"];

    // ---- Migration and seeding -------------------------------------------------------------------------------

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-05")]
    public async Task TC_PROMO_1_05_Startup_migration_creates_the_five_tables_on_an_empty_database()
    {
        var connectionString = await infrastructure.CreateDatabaseAsync();
        var before = await Query<string>(connectionString, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        Assert.Empty(before);

        using var host = new PromotionsApiHost(connectionString, infrastructure.RabbitMqConnectionString);
        using var client = host.CreateClient();

        var tables = await Query<string>(connectionString, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
        foreach (var table in new[] { "Promotions", "PromotionTargets", "Coupons", "CouponRedemptions", "IntegrationEventLog" })
        {
            Assert.Contains(table, tables);
        }

        // PROMO-2 adds the PromotionRuleModel migration after PROMO-1's Initial.
        var history = await Query<string>(connectionString, "SELECT \"MigrationId\" FROM \"__EFMigrationsHistory\" ORDER BY \"MigrationId\"");
        Assert.Equal(2, history.Count);
        Assert.EndsWith("_Initial", history[0]);
        Assert.EndsWith("_PromotionRuleModel", history[1]);
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-06")]
    public async Task TC_PROMO_1_06_Seeder_inserts_exactly_the_four_seeded_promotions()
    {
        var now = DateTimeOffset.UtcNow;
        using var host = await StartSeededAsync(now);

        await using var context = host.CreateContext();
        var promotions = await context.Promotions.AsNoTracking().OrderBy(p => p.Id).ToListAsync(Ct);

        Assert.Equal(4, promotions.Count);
        Assert.Equal(
            ["AmountOffOrder:False", "BuyXGetY:False", "PercentOff:False", "PercentOff:True"],
            promotions.Select(p => $"{p.Type}:{p.RequiresCoupon}").Order(StringComparer.Ordinal));
        Assert.All(promotions, p => Assert.Equal(PromotionStatus.Published, p.Status));
        Assert.All(promotions, p =>
        {
            Assert.True((p.StartsAt - now.AddDays(-1)).Duration() < TimeSpan.FromMinutes(1), $"StartsAt {p.StartsAt:O}");
            Assert.True(p.EndsAt >= now.AddDays(60), $"EndsAt {p.EndsAt:O}");
        });
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-07")]
    public async Task TC_PROMO_1_07_Seeder_inserts_coupons_FALL10_and_WELCOME5_on_the_coupon_only_promotion()
    {
        using var host = await StartSeededAsync(DateTimeOffset.UtcNow);

        await using var context = host.CreateContext();
        var coupons = await context.Coupons.AsNoTracking()
            .Join(context.Promotions, c => c.PromotionId, p => p.Id, (c, p) => new { c.Code, p.RequiresCoupon })
            .OrderBy(x => x.Code)
            .ToListAsync(Ct);

        Assert.Equal(["FALL10", "WELCOME5"], coupons.Select(c => c.Code));
        Assert.All(coupons, c => Assert.True(c.RequiresCoupon));
        Assert.Equal(0, await context.CouponRedemptions.CountAsync(Ct));
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-08")]
    public async Task TC_PROMO_1_08_Restarting_against_the_same_database_keeps_4_promotions_and_2_coupons()
    {
        var connectionString = await infrastructure.CreateDatabaseAsync();
        List<int> firstIds;
        using (var first = new PromotionsApiHost(connectionString, infrastructure.RabbitMqConnectionString))
        {
            using var client = first.CreateClient();
            await using var context = first.CreateContext();
            firstIds = await context.Promotions.OrderBy(p => p.Id).Select(p => p.Id).ToListAsync(Ct);
        }

        Assert.Equal(4, firstIds.Count);

        // The first host is stopped; the database stays untouched. Starting the second host throws if startup fails.
        using var second = new PromotionsApiHost(connectionString, infrastructure.RabbitMqConnectionString);
        using var secondClient = second.CreateClient();

        await using var secondContext = second.CreateContext();
        Assert.Equal(firstIds, await secondContext.Promotions.OrderBy(p => p.Id).Select(p => p.Id).ToListAsync(Ct));
        Assert.Equal(2, await secondContext.Coupons.CountAsync(Ct));
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-09")]
    public async Task TC_PROMO_1_09_Seeder_inserts_nothing_when_Promotions_already_has_a_row()
    {
        var connectionString = await infrastructure.CreateDatabaseAsync();
        var now = DateTimeOffset.UtcNow;

        // Precondition: migrated database with exactly one non-seed row.
        using (var host = new PromotionsApiHost(connectionString, infrastructure.RabbitMqConnectionString, seedingDisabled: true))
        {
            using var client = host.CreateClient();
            await using var context = host.CreateContext();
            context.Promotions.Add(NewPromotion("Custom", PromotionStatus.Draft, now.AddDays(-1), now.AddDays(30), 1));
            await context.SaveChangesAsync(Ct);
            Assert.Equal(0, await context.Coupons.CountAsync(Ct));
        }

        using var seeding = new PromotionsApiHost(connectionString, infrastructure.RabbitMqConnectionString, seedingDisabled: false);
        using var seedingClient = seeding.CreateClient();

        await using var check = seeding.CreateContext();
        var promotion = Assert.Single(await check.Promotions.AsNoTracking().ToListAsync(Ct));
        Assert.Equal("Custom", promotion.Name);
        Assert.Equal(0, await check.Coupons.CountAsync(Ct));
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-10")]
    public async Task TC_PROMO_1_10_Health_and_alive_return_200_when_the_database_is_reachable()
    {
        using var host = await StartSeededAsync(DateTimeOffset.UtcNow);
        using var client = host.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/alive", Ct)).StatusCode);
    }

    // ---- GET /api/promotions/active --------------------------------------------------------------------------

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-11")]
    public async Task TC_PROMO_1_11_GET_active_returns_the_seeded_promotions_without_coupon_and_no_inactive_ones()
    {
        var now = DateTimeOffset.UtcNow;
        using var host = await StartSeededAsync(now);
        // PROMO-2: the coupon-only seeded promotion is left out of the public feed.
        var seededIds = await Ids(host, includeCouponOnly: false);
        await AddInactiveExtrasAsync(host, now);

        using var client = host.CreateClient();
        var response = await client.GetAsync(Active, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var promotions = await ReadArray(response);
        Assert.Equal(3, promotions.Count);
        Assert.Equal(seededIds.Order(), promotions.Select(p => p.GetProperty("id").GetInt32()).Order());
        Assert.DoesNotContain(promotions, p => p.GetProperty("requiresCoupon").GetBoolean());
        Assert.DoesNotContain(promotions, p => p.GetProperty("name").GetString() is "Draft" or "Ended yesterday" or "Starts tomorrow");
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-12")]
    public async Task TC_PROMO_1_12_GET_active_orders_promotions_by_priority_descending()
    {
        using var host = await StartSeededAsync(DateTimeOffset.UtcNow);
        using var client = host.CreateClient();

        var response = await client.GetAsync(Active, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var promotions = await ReadArray(response);
        Assert.Equal([10, 8, 6], promotions.Select(p => p.GetProperty("priority").GetInt32()));
        Assert.Equal(SeededNamesByPriority, promotions.Select(p => p.GetProperty("name").GetString()));
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-13")]
    public async Task TC_PROMO_1_13_Promotions_with_equal_priority_are_ordered_by_id_ascending()
    {
        var now = DateTimeOffset.UtcNow;
        using var host = await StartSeededAsync(now);
        await using (var context = host.CreateContext())
        {
            // Inserted in reverse id order: the higher id first.
            context.Promotions.Add(NewPromotion("Tie high id", PromotionStatus.Published, now.AddDays(-1), now.AddDays(30), 100, id: 9001));
            await context.SaveChangesAsync(Ct);
            context.Promotions.Add(NewPromotion("Tie low id", PromotionStatus.Published, now.AddDays(-1), now.AddDays(30), 100, id: 9000));
            await context.SaveChangesAsync(Ct);
        }

        using var client = host.CreateClient();
        var response = await client.GetAsync(Active, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var promotions = await ReadArray(response);
        Assert.Equal(5, promotions.Count);
        Assert.Equal([100, 100], promotions.Take(2).Select(p => p.GetProperty("priority").GetInt32()));
        Assert.Equal([9000, 9001], promotions.Take(2).Select(p => p.GetProperty("id").GetInt32()));
        Assert.Equal([10, 8, 6], promotions.Skip(2).Select(p => p.GetProperty("priority").GetInt32()));
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-14")]
    public async Task TC_PROMO_1_14_Each_active_promotion_has_the_required_fields()
    {
        using var host = await StartSeededAsync(DateTimeOffset.UtcNow);
        using var client = host.CreateClient();

        var response = await client.GetAsync(Active, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var promotions = await ReadArray(response);
        Assert.Equal(3, promotions.Count);
        foreach (var promotion in promotions)
        {
            // PROMO-2 public shape: status is no longer part of it.
            var names = promotion.EnumerateObject().Select(p => p.Name).ToHashSet();
            Assert.True(
                new[] { "id", "name", "description", "type", "value", "badgeLabel", "targets", "startsAt", "endsAt", "priority", "requiresCoupon" }.All(names.Contains),
                $"Missing properties in {promotion}");
            Assert.DoesNotContain("status", names);
            Assert.Equal(JsonValueKind.String, promotion.GetProperty("type").ValueKind);
            Assert.True(promotion.GetProperty("startsAt").GetDateTimeOffset() < promotion.GetProperty("endsAt").GetDateTimeOffset());
        }

        Assert.Equal(["PercentOff", "AmountOffOrder", "BuyXGetY"], promotions.Select(p => p.GetProperty("type").GetString()));
        Assert.Equal(["-20%", "$10 off", "Buy 2 Get 1"], promotions.Select(p => p.GetProperty("badgeLabel").GetString()));
        Assert.All(promotions, p => Assert.False(p.GetProperty("requiresCoupon").GetBoolean()));
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-15")]
    public async Task TC_PROMO_1_15_GET_active_returns_200_and_an_empty_array_when_nothing_is_active()
    {
        using var host = await StartSeededAsync(DateTimeOffset.UtcNow);
        await using (var context = host.CreateContext())
        {
            await context.Promotions.ExecuteUpdateAsync(s => s.SetProperty(p => p.Status, PromotionStatus.Draft), Ct);
        }

        using var client = host.CreateClient();
        var response = await client.GetAsync(Active, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("[]", (await response.Content.ReadAsStringAsync(Ct)).Trim());
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-16")]
    public async Task TC_PROMO_1_16_A_promotion_with_StartsAt_equal_to_now_is_active()
    {
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        using var host = await StartEmptyAsync(now);
        await using (var context = host.CreateContext())
        {
            context.Promotions.Add(NewPromotion("Starts now", PromotionStatus.Published, now, now.AddDays(10), 1));
            await context.SaveChangesAsync(Ct);
        }

        using var client = host.CreateClient();
        var response = await client.GetAsync(Active, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var promotion = Assert.Single(await ReadArray(response));
        Assert.Equal("Starts now", promotion.GetProperty("name").GetString());
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-17")]
    public async Task TC_PROMO_1_17_A_promotion_with_EndsAt_equal_to_now_is_not_active()
    {
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        using var host = await StartEmptyAsync(now);
        await using (var context = host.CreateContext())
        {
            context.Promotions.Add(NewPromotion("Ends now", PromotionStatus.Published, now.AddDays(-10), now, 2));
            context.Promotions.Add(NewPromotion("Ends in a second", PromotionStatus.Published, now.AddDays(-10), now.AddSeconds(1), 1));
            await context.SaveChangesAsync(Ct);
        }

        using var client = host.CreateClient();
        var response = await client.GetAsync(Active, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var promotion = Assert.Single(await ReadArray(response));
        Assert.Equal("Ends in a second", promotion.GetProperty("name").GetString());
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-18")]
    public async Task TC_PROMO_1_18_GET_active_ignores_a_malformed_bearer_token()
    {
        var now = DateTimeOffset.UtcNow;
        using var host = await StartSeededAsync(now);
        await AddInactiveExtrasAsync(host, now);
        using var client = host.CreateClient();

        var anonymous = await client.GetAsync(Active, Ct);
        using var request = new HttpRequestMessage(HttpMethod.Get, Active);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "not-a-jwt");
        var response = await client.SendAsync(request, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var promotions = await ReadArray(response);
        Assert.Equal(3, promotions.Count);
        Assert.Equal(SeededNamesByPriority, promotions.Select(p => p.GetProperty("name").GetString()));
        Assert.Equal(await anonymous.Content.ReadAsStringAsync(Ct), await response.Content.ReadAsStringAsync(Ct));
    }

    // ---- GET /api/promotions (token required) ---------------------------------------------------------------

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-22")]
    public async Task TC_PROMO_1_22_GET_list_without_a_token_returns_401()
    {
        using var host = await StartSeededAsync(DateTimeOffset.UtcNow);
        using var client = host.CreateClient();

        var response = await client.GetAsync(List, Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.DoesNotContain("percent", (await response.Content.ReadAsStringAsync(Ct)), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("everything", (await response.Content.ReadAsStringAsync(Ct)), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("TestCase", "TC-PROMO-1-23")]
    public async Task TC_PROMO_1_23_GET_list_with_a_malformed_token_returns_401()
    {
        using var host = await StartSeededAsync(DateTimeOffset.UtcNow);
        using var client = host.CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Get, List);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "not-a-jwt");
        var response = await client.SendAsync(request, Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.DoesNotContain("everything", await response.Content.ReadAsStringAsync(Ct), StringComparison.OrdinalIgnoreCase);
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    private async Task<PromotionsApiHost> StartSeededAsync(DateTimeOffset now)
    {
        var host = new PromotionsApiHost(await infrastructure.CreateDatabaseAsync(), infrastructure.RabbitMqConnectionString, timeProvider: new FixedTimeProvider(now));
        _ = host.Server; // starts the host: migrates and seeds before returning
        return host;
    }

    private async Task<PromotionsApiHost> StartEmptyAsync(DateTimeOffset now)
    {
        var host = new PromotionsApiHost(await infrastructure.CreateDatabaseAsync(), infrastructure.RabbitMqConnectionString, seedingDisabled: true, timeProvider: new FixedTimeProvider(now));
        _ = host.Server;
        return host;
    }

    private static async Task<List<int>> Ids(PromotionsApiHost host, bool includeCouponOnly = true)
    {
        await using var context = host.CreateContext();
        return await context.Promotions.Where(p => includeCouponOnly || !p.RequiresCoupon).Select(p => p.Id).ToListAsync(Ct);
    }

    /// <summary>A Draft, an ended-yesterday and a starts-tomorrow promotion, none of which is active.</summary>
    private static async Task AddInactiveExtrasAsync(PromotionsApiHost host, DateTimeOffset now)
    {
        await using var context = host.CreateContext();
        context.Promotions.AddRange(
            NewPromotion("Draft", PromotionStatus.Draft, now.AddDays(-1), now.AddDays(30), 3),
            NewPromotion("Ended yesterday", PromotionStatus.Published, now.AddDays(-10), now.AddDays(-1), 2),
            NewPromotion("Starts tomorrow", PromotionStatus.Published, now.AddDays(1), now.AddDays(30), 1));
        await context.SaveChangesAsync(Ct);
    }

    private static Promotion NewPromotion(string name, PromotionStatus status, DateTimeOffset startsAt, DateTimeOffset endsAt, int priority, int id = 0) => new()
    {
        Id = id,
        Name = name,
        Description = name,
        Type = PromotionType.PercentOff,
        Status = status,
        StartsAt = startsAt,
        EndsAt = endsAt,
        Priority = priority,
        Value = 5m,
    };

    private static async Task<List<JsonElement>> ReadArray(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct));
        Assert.Equal(JsonValueKind.Array, document.RootElement.ValueKind);
        return document.RootElement.EnumerateArray().Select(e => e.Clone()).ToList();
    }

    private static async Task<List<T>> Query<T>(string connectionString, string sql)
    {
        var rows = new List<T>();
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(sql, connection);
        await using var reader = await command.ExecuteReaderAsync(Ct);
        while (await reader.ReadAsync(Ct))
        {
            rows.Add(reader.GetFieldValue<T>(0));
        }

        return rows;
    }
}
