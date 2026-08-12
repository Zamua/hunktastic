function processOrder(order) {
  if (flags.asyncCheckout) {
    validate(order);
    const total = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
    charge(order.customer, total);
    ship(order);
  } else {
    legacyProcess(order);
  }
}

function refund(order) {
  return payments.reverse(order.id);
}
