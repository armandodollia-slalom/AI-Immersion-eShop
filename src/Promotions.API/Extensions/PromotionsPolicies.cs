using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;

namespace Promotions.API;

/// <summary>
/// Authorization policies of the Promotions API.
/// </summary>
public static class PromotionsPolicies
{
    /// <summary>
    /// Store administrators: an authenticated caller whose access token carries scope <c>promotions</c>
    /// and role <c>admin</c> (issued by Identity.API's ProfileService). Anonymous callers get 401,
    /// signed-in callers without the role or scope get 403.
    /// </summary>
    public const string Admin = "PromotionsAdmin";

    public const string AdminRole = "admin";

    public const string Scope = "promotions";

    // The JWT bearer handler maps the token's 'role' claim to ClaimTypes.Role by default; accept the
    // raw 'role' type too so the policy does not depend on inbound claim mapping.
    private static readonly string[] RoleClaimTypes = [ClaimTypes.Role, "role"];

    public static AuthorizationBuilder AddPromotionsPolicies(this AuthorizationBuilder authorization) =>
        authorization.AddPolicy(Admin, policy => policy
            .RequireAuthenticatedUser()
            .RequireClaim("scope", Scope)
            .RequireAssertion(context => IsAdmin(context.User)));

    public static bool IsAdmin(ClaimsPrincipal user) =>
        user.Claims.Any(claim => RoleClaimTypes.Contains(claim.Type) && claim.Value == AdminRole);
}
