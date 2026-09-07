export type Order = { id: string; total: number }

export function createOrder(id: string, total: number): Order {
  return { id, total }
}
