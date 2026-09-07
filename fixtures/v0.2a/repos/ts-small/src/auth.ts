export type AuthToken = { subject: string; expiresAt: number }

export function validateToken(token: AuthToken, now: number): boolean {
  return token.subject.length > 0 && token.expiresAt > now
}

export function loadOrder(orderId: string): string {
  return `order:${orderId}`
}
