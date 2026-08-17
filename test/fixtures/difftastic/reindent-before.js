function processOrder(order) {
  validate(order);
  const total = order.items.reduce((sum, item) => sum + item.price, 0);
  charge(order.customer, total);
  ship(order);
}

function refund(order) {
  return payments.reverse(order.id);
}
