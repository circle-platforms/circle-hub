// Placeholder for the assembly step of the next phase: it will build ServerDeps from the real runs, knowledge and connectors
// packages and register the CLI commands that need them (pack, resource, secret, knowledge). Until then serve refuses to
// start with a clear message; serve --migrate-only and the records-only commands work without it.
import type { AssembleFunction, RegisterCommand } from './api.ts';
import { AssemblyMissingError } from './errors.ts';

export const assemble: AssembleFunction = () => {
  throw new AssemblyMissingError();
};

export function registerCommands(_register: RegisterCommand): void {
  // Nothing to register before the real assembly exists.
}
