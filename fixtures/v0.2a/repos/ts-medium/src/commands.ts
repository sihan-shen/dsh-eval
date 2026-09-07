export type Command = { name: string; run: () => string }

export function registerCommand(command: Command): Command {
  return command
}

export function executeCommand(command: Command): string {
  return command.run()
}
