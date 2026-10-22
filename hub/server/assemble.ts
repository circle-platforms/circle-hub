// The assembly of the Hub (the AssemblyModule main.ts and cli.ts load): assemble(config, records) builds the server's
// dependencies from the real packages (hub/server/assemble/hub.ts) for `serve`, with the vault master key required (a
// missing key stops the process, the key is never created) and pack functions under sandbox-exec; assembleCommand does the
// same for one CLI command (`run show`, through CliContext.deps()) without the key, the probe or start-up notices;
// registerCommands adds the administrator commands (pack, resource, secret, knowledge, init-admin, operator-token) of
// hub/server/cli-admin.ts.
import type { AssembleFunction, CommandAssembleFunction, RegisterCommand } from './api.ts';
import { createAssembly, createCommandAssembly } from './assemble/hub.ts';
import { adminCommands } from './cli-admin.ts';

export { assembleHub, createAssembly, createCommandAssembly } from './assemble/hub.ts';
export type { AssembledHub, AssemblyOptions, CommandAssembleFunction, CommandIo } from './assemble/hub.ts';
export { adminCommands, operatorAdmin } from './cli-admin.ts';
export type { AdminCommandOptions } from './cli-admin.ts';

/** `serve`'s assembly. */
export const assemble: AssembleFunction = createAssembly();

/** A CLI command's assembly (AssemblyModule.assembleCommand, the server core's ctx.deps(), for `run show`). */
export const assembleCommand: CommandAssembleFunction = createCommandAssembly();

export function registerCommands(register: RegisterCommand): void {
  for (const command of adminCommands()) register(command);
}
