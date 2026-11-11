using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Promotions.API.Migrations
{
    /// <summary>
    /// PROMO-2: reshapes PROMO-1's Promotions and PromotionTargets to the promotion rule model and keeps existing rows
    /// (PercentOff/AmountOff fold into Value, Archived becomes Ended, target types map to scopes).
    /// Coupons and CouponRedemptions are left as they are.
    /// </summary>
    public partial class PromotionRuleModel : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Promotions: new columns first, then move data, then drop the PROMO-1 discount columns.
            migrationBuilder.AddColumn<string>(
                name: "Description",
                table: "Promotions",
                type: "character varying(500)",
                maxLength: 500,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<decimal>(
                name: "Value",
                table: "Promotions",
                type: "numeric(18,2)",
                precision: 18,
                scale: 2,
                nullable: false,
                defaultValue: 0m);

            migrationBuilder.AddColumn<decimal>(
                name: "MinOrderTotal",
                table: "Promotions",
                type: "numeric(18,2)",
                precision: 18,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "IsStackable",
                table: "Promotions",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "StartedEventSentAt",
                table: "Promotions",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "EndedEventSentAt",
                table: "Promotions",
                type: "timestamp with time zone",
                nullable: true);

            // Version maps to the Postgres system column xmin (concurrency token): it exists on every row, so no DDL here.

            migrationBuilder.Sql("""
                UPDATE "Promotions" SET
                    "Value" = CASE "Type"
                        WHEN 'PercentOff' THEN COALESCE("PercentOff", 0)
                        WHEN 'AmountOffOrder' THEN COALESCE("AmountOff", 0)
                        ELSE 0 END,
                    "MinOrderTotal" = CASE WHEN "Type" = 'AmountOffOrder' THEN 0 ELSE NULL END,
                    "Description" = LEFT("Name", 500),
                    "Name" = LEFT("Name", 100),
                    "Status" = CASE WHEN "Status" = 'Archived' THEN 'Ended' ELSE "Status" END;
                """);

            migrationBuilder.DropColumn(
                name: "PercentOff",
                table: "Promotions");

            migrationBuilder.DropColumn(
                name: "AmountOff",
                table: "Promotions");

            migrationBuilder.AlterColumn<string>(
                name: "Name",
                table: "Promotions",
                type: "character varying(100)",
                maxLength: 100,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "character varying(200)",
                oldMaxLength: 200);

            // PromotionTargets: TargetType (CatalogItem/CatalogBrand/CatalogType) becomes Scope (Product/Brand/Type, plus All).
            migrationBuilder.RenameColumn(
                name: "TargetType",
                table: "PromotionTargets",
                newName: "Scope");

            migrationBuilder.AlterColumn<int>(
                name: "TargetId",
                table: "PromotionTargets",
                type: "integer",
                nullable: true,
                oldClrType: typeof(int),
                oldType: "integer");

            migrationBuilder.Sql("""
                UPDATE "PromotionTargets" SET "Scope" = CASE "Scope"
                    WHEN 'CatalogItem' THEN 'Product'
                    WHEN 'CatalogBrand' THEN 'Brand'
                    WHEN 'CatalogType' THEN 'Type'
                    ELSE "Scope" END;
                """);

            // PROMO-1 promotions without a target applied to everything: give them an explicit All target.
            migrationBuilder.Sql("""
                INSERT INTO "PromotionTargets" ("PromotionId", "Scope", "TargetId")
                SELECT p."Id", 'All', NULL FROM "Promotions" p
                WHERE NOT EXISTS (SELECT 1 FROM "PromotionTargets" t WHERE t."PromotionId" = p."Id");
                """);

            migrationBuilder.AddCheckConstraint(
                name: "CK_PromotionTargets_TargetId_Scope",
                table: "PromotionTargets",
                sql: "(\"Scope\" = 'All') = (\"TargetId\" IS NULL)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_PromotionTargets_TargetId_Scope",
                table: "PromotionTargets");

            migrationBuilder.Sql("""DELETE FROM "PromotionTargets" WHERE "Scope" = 'All';""");

            migrationBuilder.Sql("""
                UPDATE "PromotionTargets" SET "Scope" = CASE "Scope"
                    WHEN 'Product' THEN 'CatalogItem'
                    WHEN 'Brand' THEN 'CatalogBrand'
                    WHEN 'Type' THEN 'CatalogType'
                    ELSE "Scope" END;
                """);

            migrationBuilder.AlterColumn<int>(
                name: "TargetId",
                table: "PromotionTargets",
                type: "integer",
                nullable: false,
                defaultValue: 0,
                oldClrType: typeof(int),
                oldType: "integer",
                oldNullable: true);

            migrationBuilder.RenameColumn(
                name: "Scope",
                table: "PromotionTargets",
                newName: "TargetType");

            migrationBuilder.AlterColumn<string>(
                name: "Name",
                table: "Promotions",
                type: "character varying(200)",
                maxLength: 200,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "character varying(100)",
                oldMaxLength: 100);

            migrationBuilder.AddColumn<decimal>(
                name: "PercentOff",
                table: "Promotions",
                type: "numeric(5,2)",
                precision: 5,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "AmountOff",
                table: "Promotions",
                type: "numeric(18,2)",
                precision: 18,
                scale: 2,
                nullable: true);

            migrationBuilder.Sql("""
                UPDATE "Promotions" SET
                    "PercentOff" = CASE WHEN "Type" = 'PercentOff' THEN "Value" ELSE NULL END,
                    "AmountOff" = CASE WHEN "Type" = 'AmountOffOrder' THEN "Value" ELSE NULL END,
                    "Status" = CASE WHEN "Status" = 'Ended' THEN 'Archived' ELSE "Status" END;
                """);

            migrationBuilder.DropColumn(
                name: "Description",
                table: "Promotions");

            migrationBuilder.DropColumn(
                name: "Value",
                table: "Promotions");

            migrationBuilder.DropColumn(
                name: "MinOrderTotal",
                table: "Promotions");

            migrationBuilder.DropColumn(
                name: "IsStackable",
                table: "Promotions");

            migrationBuilder.DropColumn(
                name: "StartedEventSentAt",
                table: "Promotions");

            migrationBuilder.DropColumn(
                name: "EndedEventSentAt",
                table: "Promotions");
        }
    }
}
