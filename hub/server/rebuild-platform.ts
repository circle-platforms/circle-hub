import { assertResetTarget } from './reset-target.ts';
import { ZodError } from 'zod';
import type { HubConfig } from '../config/index.ts';
import type { RebuildResetBridge } from './rebuild-http.ts';

/** Uses only the platform's public, fixed reset worker; never runs resetData in the serving process. */
export async function createPlatformRebuildBridge(config: HubConfig, env: NodeJS.ProcessEnv): Promise<RebuildResetBridge> {
  const platform = await import('../platform/api.ts');
  const context = platform.createContext({ ...env, [platform.DATA_ROOT_VARIABLE]: config.dataDir });
  assertResetTarget(config.database, platform.postgresFor(context).target);
  const { boundResetConfigurationPorts } = await import('./reset-configuration.ts');
  const ports = boundResetConfigurationPorts(config, context, async path => {
    const { main } = await import('./cli.ts');
    const code = await main(['apply', path], { io: { env: { ...env }, cwd: process.cwd(), stdout: () => {}, stderr: () => {} } });
    if (code !== 0) throw new Error('部署定义应用未完成，重建必须恢复原状态');
  });
  return {
    async validate(input) {
      try { return await platform.parseResetRequest(input); }
      catch (error) { if (error instanceof ZodError) return null; throw error; }
    },
    inspect: () => platform.inspectReset(context),
    preview: request => platform.previewReset(context, request, ports),
    launch: (request, authorizationContext) => platform.launchReset(context, request, authorizationContext),
    acknowledge: (operationId, authorizationContext) => platform.acknowledgeReset(context, operationId, authorizationContext),
    status: (operationId, authorizationContext) => platform.readResetStatus(context, operationId, authorizationContext),
  };
}
