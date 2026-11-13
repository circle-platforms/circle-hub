import type { CliOptions } from './cli.ts';
import { loadServerConfig } from './main.ts';
import { createContext } from '../platform/api.ts';
import { boundResetConfigurationPorts, resetOwnerEnvironment } from './reset-configuration.ts';
import { CliError } from './errors.ts';
import { takeEnvironmentToken } from './assemble/operator-token.ts';

/** Dispatch before ordinary CLI contexts and telemetry: an incompatible store cannot open a records session. */
export async function dispatchReset(args: readonly string[], options: CliOptions): Promise<number> {
  const { resetCommand, parseResetArguments, resetUsage } = await import('./reset/cli.ts');
  let parsed: ReturnType<typeof parseResetArguments>;
  try { parsed = parseResetArguments(args); }
  catch { options.io.stderr(resetUsage()); return 2; }
  if (parsed.help) { options.io.stdout(resetUsage()); return 0; }
  const config = loadServerConfig(options.io.env, { command: true });
  const workerEnvironment = { ...options.io.env };
  takeEnvironmentToken(workerEnvironment);
  const context = createContext(workerEnvironment);
  const ports = boundResetConfigurationPorts(config, context, async path => {
    const { main } = await import('./cli.ts');
    const code = await main(['apply', path], { ...options, io: { ...options.io, env: resetOwnerEnvironment(config,context,options.io.env) } });
    if (code !== 0) throw new CliError('部署定义应用未完成，重建必须恢复原状态');
  });
  return resetCommand(args, context, options.io, ports);
}
