using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace AgentOps.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "agentops");

            migrationBuilder.CreateTable(
                name: "agents",
                schema: "agentops",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    FirstSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_agents", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ingest_batches",
                schema: "agentops",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    BatchId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PullRequestId = table.Column<int>(type: "integer", nullable: false),
                    HeadSha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ReviewsInserted = table.Column<int>(type: "integer", nullable: false),
                    MistakesInserted = table.Column<int>(type: "integer", nullable: false),
                    EventsSkipped = table.Column<int>(type: "integer", nullable: false),
                    IngestedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ingest_batches", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "pull_requests",
                schema: "agentops",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Number = table.Column<int>(type: "integer", nullable: false),
                    Title = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Author = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Url = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    HeadSha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Labels = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    FirstSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastIngestedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_pull_requests", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "review_runs",
                schema: "agentops",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EventId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PullRequestId = table.Column<int>(type: "integer", nullable: false),
                    AgentId = table.Column<int>(type: "integer", nullable: false),
                    Source = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Story = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Stage = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Round = table.Column<int>(type: "integer", nullable: true),
                    Verdict = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Passed = table.Column<bool>(type: "boolean", nullable: false),
                    Score = table.Column<int>(type: "integer", nullable: true),
                    OccurredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_review_runs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_review_runs_agents_AgentId",
                        column: x => x.AgentId,
                        principalSchema: "agentops",
                        principalTable: "agents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_review_runs_pull_requests_PullRequestId",
                        column: x => x.PullRequestId,
                        principalSchema: "agentops",
                        principalTable: "pull_requests",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "mistakes",
                schema: "agentops",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EventId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PullRequestId = table.Column<int>(type: "integer", nullable: false),
                    AgentId = table.Column<int>(type: "integer", nullable: false),
                    ReviewRunId = table.Column<long>(type: "bigint", nullable: true),
                    Source = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Category = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Rule = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Subtype = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Severity = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    File = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    Line = table.Column<int>(type: "integer", nullable: true),
                    Message = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    MistakeKey = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Fingerprint = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Story = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Stage = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    Round = table.Column<int>(type: "integer", nullable: true),
                    OccurredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_mistakes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_mistakes_agents_AgentId",
                        column: x => x.AgentId,
                        principalSchema: "agentops",
                        principalTable: "agents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_mistakes_pull_requests_PullRequestId",
                        column: x => x.PullRequestId,
                        principalSchema: "agentops",
                        principalTable: "pull_requests",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_mistakes_review_runs_ReviewRunId",
                        column: x => x.ReviewRunId,
                        principalSchema: "agentops",
                        principalTable: "review_runs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_agents_Name",
                schema: "agentops",
                table: "agents",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ingest_batches_BatchId",
                schema: "agentops",
                table: "ingest_batches",
                column: "BatchId");

            migrationBuilder.CreateIndex(
                name: "IX_mistakes_AgentId_MistakeKey",
                schema: "agentops",
                table: "mistakes",
                columns: new[] { "AgentId", "MistakeKey" });

            migrationBuilder.CreateIndex(
                name: "IX_mistakes_EventId",
                schema: "agentops",
                table: "mistakes",
                column: "EventId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_mistakes_OccurredAt",
                schema: "agentops",
                table: "mistakes",
                column: "OccurredAt");

            migrationBuilder.CreateIndex(
                name: "IX_mistakes_PullRequestId",
                schema: "agentops",
                table: "mistakes",
                column: "PullRequestId");

            migrationBuilder.CreateIndex(
                name: "IX_mistakes_ReviewRunId",
                schema: "agentops",
                table: "mistakes",
                column: "ReviewRunId");

            migrationBuilder.CreateIndex(
                name: "IX_pull_requests_Number",
                schema: "agentops",
                table: "pull_requests",
                column: "Number",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_review_runs_AgentId_OccurredAt",
                schema: "agentops",
                table: "review_runs",
                columns: new[] { "AgentId", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_review_runs_EventId",
                schema: "agentops",
                table: "review_runs",
                column: "EventId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_review_runs_PullRequestId",
                schema: "agentops",
                table: "review_runs",
                column: "PullRequestId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ingest_batches",
                schema: "agentops");

            migrationBuilder.DropTable(
                name: "mistakes",
                schema: "agentops");

            migrationBuilder.DropTable(
                name: "review_runs",
                schema: "agentops");

            migrationBuilder.DropTable(
                name: "agents",
                schema: "agentops");

            migrationBuilder.DropTable(
                name: "pull_requests",
                schema: "agentops");
        }
    }
}
