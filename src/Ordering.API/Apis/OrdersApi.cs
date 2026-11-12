using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using CardType = eShop.Ordering.API.Application.Queries.CardType;
using Order = eShop.Ordering.API.Application.Queries.Order;

public static class OrdersApi
{
    public const string OrderingAdminPolicy = "OrderingAdmin";

    public static RouteGroupBuilder MapOrdersApiV1(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("api/orders").HasApiVersion(1.0);

        api.MapPut("/cancel", CancelOrderAsync);
        api.MapPut("/ship", ShipOrderAsync)
            .RequireAuthorization(OrderingAdminPolicy);
        api.MapGet("{orderId:int}", GetOrderAsync);
        api.MapGet("/", GetOrdersByUserAsync);
        api.MapGet("/cardtypes", GetCardTypesAsync);
        api.MapPost("/draft", CreateOrderDraftAsync);
        api.MapPost("/", CreateOrderAsync);

        return api;
    }

    public static async Task<Results<Ok, BadRequest<string>, NotFound, ProblemHttpResult>> CancelOrderAsync(
        [FromHeader(Name = "x-requestid")] Guid requestId,
        CancelOrderCommand command,
        [AsParameters] OrderServices services)
    {
        if (requestId == Guid.Empty)
        {
            return TypedResults.BadRequest("Empty GUID is not valid for request ID");
        }

        // Buyers may only cancel their own orders; anything else looks like it doesn't exist.
        if (!await IsOwnOrderAsync(command.OrderNumber, services))
        {
            return TypedResults.NotFound();
        }

        var requestCancelOrder = new IdentifiedCommand<CancelOrderCommand, bool>(command, requestId);

        services.Logger.LogInformation(
            "Sending command: {CommandName} - {IdProperty}: {CommandId} ({@Command})",
            requestCancelOrder.GetGenericTypeName(),
            nameof(requestCancelOrder.Command.OrderNumber),
            requestCancelOrder.Command.OrderNumber,
            requestCancelOrder);

        bool commandResult;
        try
        {
            commandResult = await services.Mediator.Send(requestCancelOrder);
        }
        catch (OrderingDomainException ex)
        {
            return OrderStatusConflict(ex);
        }

        if (!commandResult)
        {
            return TypedResults.Problem(detail: "Cancel order failed to process.", statusCode: 500);
        }

        return TypedResults.Ok();
    }

    public static async Task<Results<Ok, BadRequest<string>, NotFound, ProblemHttpResult>> ShipOrderAsync(
        [FromHeader(Name = "x-requestid")] Guid requestId,
        ShipOrderCommand command,
        [AsParameters] OrderServices services)
    {
        if (requestId == Guid.Empty)
        {
            return TypedResults.BadRequest("Empty GUID is not valid for request ID");
        }

        if (!await services.Queries.OrderExistsAsync(command.OrderNumber))
        {
            return TypedResults.NotFound();
        }

        var requestShipOrder = new IdentifiedCommand<ShipOrderCommand, bool>(command, requestId);

        services.Logger.LogInformation(
            "Sending command: {CommandName} - {IdProperty}: {CommandId} ({@Command})",
            requestShipOrder.GetGenericTypeName(),
            nameof(requestShipOrder.Command.OrderNumber),
            requestShipOrder.Command.OrderNumber,
            requestShipOrder);

        bool commandResult;
        try
        {
            commandResult = await services.Mediator.Send(requestShipOrder);
        }
        catch (OrderingDomainException ex)
        {
            return OrderStatusConflict(ex);
        }

        if (!commandResult)
        {
            return TypedResults.Problem(detail: "Ship order failed to process.", statusCode: 500);
        }

        return TypedResults.Ok();
    }

    // An order status rule (e.g. "Shipped orders can't be cancelled") was broken: the request conflicts with the order's state.
    private static ProblemHttpResult OrderStatusConflict(OrderingDomainException ex) =>
        TypedResults.Problem(detail: ex.Message, statusCode: StatusCodes.Status409Conflict);

    private static async Task<bool> IsOwnOrderAsync(int orderNumber, OrderServices services)
    {
        try
        {
            var userId = services.IdentityService.GetUserIdentity();
            return await services.Queries.GetOrderAsync(orderNumber, userId) is not null;
        }
        catch (KeyNotFoundException)
        {
            return false;
        }
    }

    public static async Task<Results<Ok<Order>, NotFound>> GetOrderAsync(int orderId, [AsParameters] OrderServices services)
    {
        try
        {
            var userId = services.IdentityService.GetUserIdentity();
            var order = await services.Queries.GetOrderAsync(orderId, userId);
            return TypedResults.Ok(order);
        }
        catch
        {
            return TypedResults.NotFound();
        }
    }

    public static async Task<Ok<IEnumerable<OrderSummary>>> GetOrdersByUserAsync([AsParameters] OrderServices services)
    {
        var userId = services.IdentityService.GetUserIdentity();
        var orders = await services.Queries.GetOrdersFromUserAsync(userId);
        return TypedResults.Ok(orders);
    }

    public static async Task<Ok<IEnumerable<CardType>>> GetCardTypesAsync(IOrderQueries orderQueries)
    {
        var cardTypes = await orderQueries.GetCardTypesAsync();
        return TypedResults.Ok(cardTypes);
    }

    // The body may be empty so a missing body or missing items gets a 400 ValidationProblem instead of a binding failure.
    public static async Task<Results<Ok<OrderDraftDTO>, ValidationProblem>> CreateOrderDraftAsync(
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] CreateOrderDraftCommand command,
        [AsParameters] OrderServices services)
    {
        if (command is null)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            {
                [string.Empty] = ["A request body with the basket items is required."]
            });
        }

        if (command.Items is null)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            {
                [nameof(CreateOrderDraftCommand.Items)] = ["Items is required."]
            });
        }

        services.Logger.LogInformation(
            "Sending command: {CommandName} - {IdProperty}: {CommandId} ({@Command})",
            command.GetGenericTypeName(),
            nameof(command.BuyerId),
            command.BuyerId,
            command);

        return TypedResults.Ok(await services.Mediator.Send(command));
    }

    // The order was not created: the command failed validation (the validator's messages, grouped by property)
    // or broke a domain rule (the exception's message).
    private static ValidationProblem CreateOrderValidationProblem(OrderingDomainException ex)
    {
        var errors = ex.InnerException is ValidationException { Errors: var failures } && failures.Any()
            ? failures
                .GroupBy(failure => failure.PropertyName)
                .ToDictionary(group => group.Key, group => group.Select(failure => failure.ErrorMessage).ToArray())
            : new Dictionary<string, string[]> { [string.Empty] = [ex.Message] };

        return TypedResults.ValidationProblem(errors);
    }

    public static async Task<Results<Ok, BadRequest<string>, ValidationProblem>> CreateOrderAsync(
        [FromHeader(Name = "x-requestid")] Guid requestId,
        CreateOrderRequest request,
        [AsParameters] OrderServices services)
    {

        // The buyer is always the signed-in user; userId and userName in the body are ignored.
        var userId = services.IdentityService.GetUserIdentity();
        var userName = services.IdentityService.GetUserName();

        services.Logger.LogInformation(
            "Sending command: {CommandName} - {IdProperty}: {CommandId}",
            request.GetGenericTypeName(),
            "UserId",
            userId); //don't log the request as it has CC number

        if (requestId == Guid.Empty)
        {
            services.Logger.LogWarning("Invalid IntegrationEvent - RequestId is missing - {@IntegrationEvent}", request);
            return TypedResults.BadRequest("RequestId is missing.");
        }

        using (services.Logger.BeginScope(new List<KeyValuePair<string, object>> { new("IdentifiedCommandId", requestId) }))
        {
            var maskedCCNumber = request.CardNumber.Substring(request.CardNumber.Length - 4).PadLeft(request.CardNumber.Length, 'X');
            var createOrderCommand = new CreateOrderCommand(request.Items, userId, userName, request.City, request.Street,
                request.State, request.Country, request.ZipCode,
                maskedCCNumber, request.CardHolderName, request.CardExpiration,
                request.CardSecurityNumber, request.CardTypeId);

            var requestCreateOrder = new IdentifiedCommand<CreateOrderCommand, bool>(createOrderCommand, requestId);

            services.Logger.LogInformation(
                "Sending command: {CommandName} - {IdProperty}: {CommandId} ({@Command})",
                requestCreateOrder.GetGenericTypeName(),
                nameof(requestCreateOrder.Id),
                requestCreateOrder.Id,
                requestCreateOrder);

            bool result;
            try
            {
                result = await services.Mediator.Send(requestCreateOrder);
            }
            catch (OrderingDomainException ex)
            {
                services.Logger.LogWarning("CreateOrderCommand failed - RequestId: {RequestId} - {Reason}", requestId, ex.Message);
                return CreateOrderValidationProblem(ex);
            }

            if (!result)
            {
                services.Logger.LogWarning("CreateOrderCommand failed - RequestId: {RequestId}", requestId);
                return TypedResults.ValidationProblem(
                    new Dictionary<string, string[]> { [string.Empty] = ["The order could not be created."] });
            }

            services.Logger.LogInformation("CreateOrderCommand succeeded - RequestId: {RequestId}", requestId);
            return TypedResults.Ok();
        }
    }
}

public record CreateOrderRequest(
    string UserId,
    string UserName,
    string City,
    string Street,
    string State,
    string Country,
    string ZipCode,
    string CardNumber,
    string CardHolderName,
    DateTime CardExpiration,
    string CardSecurityNumber,
    int CardTypeId,
    string Buyer,
    List<BasketItem> Items);
