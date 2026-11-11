using System.Security.Claims;
using Microsoft.AspNetCore.Http;

namespace eShop.Catalog.FunctionalTests;

// Signs every request in as an Admin so the functional tests can call the Admin-only write endpoints.
public sealed class TestAuthenticationMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim("sub", "test-admin"), new Claim("role", "Admin")],
            "Test",
            "name",
            "role"));
        await next(context);
    }
}
