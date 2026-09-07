import type { Order } from '../domain/order.js'
import type { OrderStore } from '../infrastructure/store.js'

export function calculateTotal(order: Order): number {
  return order.total
}

export function checkout(store: OrderStore, order: Order): boolean {
  store.saveOrder(order)
  return true
}
