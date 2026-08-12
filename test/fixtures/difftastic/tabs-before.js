function pick(list) {
  for (const item of list) {
    if (item.ok) return item;
  }
  return null;
}
