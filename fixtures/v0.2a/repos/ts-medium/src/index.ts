import { CommandRegistry } from './registry.js'

export function createRegistry(): CommandRegistry {
  return new CommandRegistry()
}
