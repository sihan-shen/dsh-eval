import type { Command } from './commands.js'

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()

  addCommand(command: Command): void {
    this.commands.set(command.name, command)
  }

  findCommand(name: string): Command | undefined {
    return this.commands.get(name)
  }
}

export function addCommand(registry: CommandRegistry, command: Command): void {
  registry.addCommand(command)
}
