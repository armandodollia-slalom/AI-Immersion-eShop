using AgentOps.Data.Model;
using Microsoft.EntityFrameworkCore;

namespace AgentOps.Data;

/// <summary>
/// The single owner of the agentopsdb schema. Only AgentOps.API and the AgentOps CLI use it.
/// </summary>
public class AgentOpsContext(DbContextOptions<AgentOpsContext> options) : DbContext(options)
{
    public const string ConnectionName = "agentopsdb";

    public DbSet<Agent> Agents => Set<Agent>();
    public DbSet<PullRequest> PullRequests => Set<PullRequest>();
    public DbSet<ReviewRun> ReviewRuns => Set<ReviewRun>();
    public DbSet<Mistake> Mistakes => Set<Mistake>();
    public DbSet<IngestBatch> IngestBatches => Set<IngestBatch>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        builder.HasDefaultSchema("agentops");

        builder.Entity<Agent>(e =>
        {
            e.ToTable("agents");
            e.Property(a => a.Name).HasMaxLength(64);
            e.HasIndex(a => a.Name).IsUnique();
        });

        builder.Entity<PullRequest>(e =>
        {
            e.ToTable("pull_requests");
            e.HasIndex(p => p.Number).IsUnique();
            e.Property(p => p.Title).HasMaxLength(Limits.Title);
            e.Property(p => p.Author).HasMaxLength(Limits.Short);
            e.Property(p => p.Url).HasMaxLength(Limits.Url);
            e.Property(p => p.HeadSha).HasMaxLength(64);
            e.Property(p => p.Labels).HasMaxLength(Limits.Message);
        });

        builder.Entity<ReviewRun>(e =>
        {
            e.ToTable("review_runs");
            e.Property(r => r.EventId).HasMaxLength(64);
            e.HasIndex(r => r.EventId).IsUnique();
            e.Property(r => r.Source).HasMaxLength(Limits.Short);
            e.Property(r => r.Story).HasMaxLength(Limits.Short);
            e.Property(r => r.Stage).HasMaxLength(Limits.Short);
            e.Property(r => r.Verdict).HasMaxLength(Limits.Short);
            e.HasIndex(r => new { r.AgentId, r.OccurredAt });
            e.HasOne(r => r.PullRequest).WithMany().HasForeignKey(r => r.PullRequestId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(r => r.Agent).WithMany().HasForeignKey(r => r.AgentId).OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<Mistake>(e =>
        {
            e.ToTable("mistakes");
            e.Property(m => m.EventId).HasMaxLength(64);
            e.HasIndex(m => m.EventId).IsUnique();
            e.Property(m => m.Source).HasMaxLength(Limits.Short);
            e.Property(m => m.Category).HasMaxLength(Limits.Short);
            e.Property(m => m.Rule).HasMaxLength(Limits.Short);
            e.Property(m => m.Subtype).HasMaxLength(Limits.Short);
            e.Property(m => m.Severity).HasMaxLength(32);
            e.Property(m => m.File).HasMaxLength(Limits.Url);
            e.Property(m => m.Message).HasMaxLength(Limits.Message);
            e.Property(m => m.MistakeKey).HasMaxLength(Limits.Title);
            e.Property(m => m.Fingerprint).HasMaxLength(64);
            e.Property(m => m.Story).HasMaxLength(Limits.Short);
            e.Property(m => m.Stage).HasMaxLength(Limits.Short);
            e.HasIndex(m => new { m.AgentId, m.MistakeKey });
            e.HasIndex(m => m.OccurredAt);
            e.HasOne(m => m.PullRequest).WithMany().HasForeignKey(m => m.PullRequestId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(m => m.Agent).WithMany().HasForeignKey(m => m.AgentId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(m => m.ReviewRun).WithMany().HasForeignKey(m => m.ReviewRunId).OnDelete(DeleteBehavior.SetNull);
        });

        builder.Entity<IngestBatch>(e =>
        {
            e.ToTable("ingest_batches");
            e.Property(b => b.BatchId).HasMaxLength(64);
            e.HasIndex(b => b.BatchId);
            e.Property(b => b.HeadSha).HasMaxLength(64);
        });
    }
}

/// <summary>Column length limits; the batch sanitizer truncates untrusted input to the same limits.</summary>
public static class Limits
{
    public const int Short = 128;
    public const int Title = 256;
    public const int Url = 512;
    public const int Message = 1000;
}
