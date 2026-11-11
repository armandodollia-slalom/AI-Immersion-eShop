namespace eShop.Ordering.API.Application.Queries;

public interface IOrderQueries
{
    Task<Order> GetOrderAsync(int id, string userId);

    Task<IEnumerable<OrderSummary>> GetOrdersFromUserAsync(string userId);

    Task<IEnumerable<CardType>> GetCardTypesAsync();
}
