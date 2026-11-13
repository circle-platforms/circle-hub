import { assertResetTarget } from './reset-target.ts';
import { ZodError } from 'zod';
import type { HubConfig } from '../config/index.ts';
import type { RebuildResetBridge } from './rebuild-http.ts';

/** Uses only the platform's public, fixed reset worker; never runs resetData in the serving process. */
export async function createPlatformRebuildBridge(config: HubConfig, env: NodeJS.ProcessEnv): Promise<RebuildResetBridge> {
  const platform = await import('../platform/api.ts');
  const context = platform.createContext({ ...env, [platform.DATA_ROOT_VARIABLE]: config.dataDir });
  assertResetTarget(config.database, platform.postgresFor(context).target);
  return {
    async validate(input) {
      try { return await platform.parseResetRequest(input); }
      catch (error) { if (error instanceof ZodError) return null; throw error; }
    },
    inspect: () => platform.inspectReset(context),
    preview: request => platform.previewReset(context, request),
    launch: (request, authorizationContext) => platform.launchReset(context, request, authorizationContext),
    acknowledge: (operationId, authorizationContext) => platform.acknowledgeReset(context, operationId, authorizationContext),
    status: (operationId, authorizationContext) => platform.readResetStatus(context, operationId, authorizationContext),
  };
}
