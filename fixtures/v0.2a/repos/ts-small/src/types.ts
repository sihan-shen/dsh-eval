export type User = { id: string; email: string }

export type RequestContext = { user: User; traceId: string }
