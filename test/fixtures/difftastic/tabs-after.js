function pick(list, limit) {
  for (const item of list.slice(0, limit)) {
    if (item.ok) return item;
  }
  return null;
}
