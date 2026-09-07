export type Service = { name: string }

export function createService(name: string): Service {
  return { name }
}

export function getService(service: Service): Service {
  return service
}
