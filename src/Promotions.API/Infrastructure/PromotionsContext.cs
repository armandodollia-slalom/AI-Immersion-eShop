namespace Promotions.API.Infrastructure;

/// <remarks>
/// Add migrations using the following command inside the 'Promotions.API' project directory:
///
/// dotnet ef migrations add [migration-name]
/// </remarks>
public class PromotionsContext(DbContextOptions<PromotionsContext> options) : DbContext(options)
{
    public DbSet<Promotion> Promotions { get; set; }
    public DbSet<PromotionTarget> PromotionTargets { get; set; }
    public DbSet<Coupon> Coupons { get; set; }
    public DbSet<CouponRedemption> CouponRedemptions { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Promotion>(eb =>
        {
            eb.ToTable("Promotions");
            eb.Property(p => p.Name).HasMaxLength(Promotion.NameMaxLength).IsRequired();
            eb.Property(p => p.Description).HasMaxLength(Promotion.DescriptionMaxLength).IsRequired();
            eb.Property(p => p.Type).HasConversion<string>().HasMaxLength(32);
            eb.Property(p => p.Status).HasConversion<string>().HasMaxLength(32);
            eb.Property(p => p.Value).HasPrecision(18, 2);
            eb.Property(p => p.MinOrderTotal).HasPrecision(18, 2);
            eb.Property(p => p.Version).IsRowVersion();
            eb.HasIndex(p => new { p.Status, p.StartsAt, p.EndsAt });
            eb.HasMany(p => p.Targets).WithOne().HasForeignKey(t => t.PromotionId).OnDelete(DeleteBehavior.Cascade);
            eb.HasMany(p => p.Coupons).WithOne().HasForeignKey(c => c.PromotionId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<PromotionTarget>(eb =>
        {
            eb.ToTable("PromotionTargets");
            eb.Property(t => t.Scope).HasConversion<string>().HasMaxLength(32);
            eb.HasIndex(t => t.PromotionId);
            eb.ToTable(t => t.HasCheckConstraint(
                "CK_PromotionTargets_TargetId_Scope",
                "(\"Scope\" = 'All') = (\"TargetId\" IS NULL)"));
        });

        modelBuilder.Entity<Coupon>(eb =>
        {
            eb.ToTable("Coupons");
            eb.Property(c => c.Code).HasMaxLength(64).IsRequired();
            eb.HasIndex(c => c.Code).IsUnique();
            eb.HasMany(c => c.Redemptions).WithOne().HasForeignKey(r => r.CouponId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<CouponRedemption>(eb =>
        {
            eb.ToTable("CouponRedemptions");
            eb.Property(r => r.UserId).HasMaxLength(256).IsRequired();
            eb.HasIndex(r => r.CouponId);
        });

        // Add the outbox table to this context
        modelBuilder.UseIntegrationEventLogs();
    }
}
