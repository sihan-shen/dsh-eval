import type { Order } from '../domain/order.js'

export class OrderStore {
  private readonly orders = new Map<string, Order>()

  saveOrder(order: Order): void {
    this.orders.set(order.id, order)
  }

  findOrder(id: string): Order | undefined {
    return this.orders.get(id)
  }
}

export function saveOrder(store: OrderStore, order: Order): void {
  store.saveOrder(order)
}
