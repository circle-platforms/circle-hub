// Startup observes durable conversion facts; a failed observation never authorizes legacy environment use.
import { isAdmin, type Principal } from '../records/api.ts';
import type { HubConfig } from '../config/index.ts';
import { deploymentKeyService, fileOperatorTokens, type OperatorTokenStore } from './assemble/operator-token.ts';

/** A startup observation, not a second permission source or a caller-controlled switch. */
export interface EnvironmentPermissionStartup {
  completed: boolean | null;
  enforced: boolean;
  missing: string | null;
  nextAction: string | null;
}

/** The records owner supplies verified absence/history and the atomic, actor-rechecking writer. */
export interface EnvironmentPermissionStartupPort {
  read(): Promise<{ completed: boolean | null }>;
  convert(actor: Principal): Promise<void>;
}

export interface EnvironmentStartupAuthority {
  authenticate(authorization: string): Promise<Principal | null>;
  readToken(): Promise<string | null>;
}

const WAITING = '测试环境分配的继承尚未完成，现在仍按原工作流和预订规则判断。';
const UNKNOWN = '测试环境分配的完成事实现在不能核对，不能重做继承或退回旧权限。';

function unknown(): EnvironmentPermissionStartup {
  return { completed: null, enforced: true, missing: UNKNOWN, nextAction: '请联系维护人员恢复完成事实的核对；本次不重新授予权限。' };
}
function pending(): EnvironmentPermissionStartup {
  return { completed: false, enforced: false, missing: WAITING, nextAction: '请管理员在普通管理页面检查操作委托；服务继续按原规则运行。' };
}
function complete(): EnvironmentPermissionStartup {
  return { completed: true, enforced: true, missing: null, nextAction: null };
}

/** Only verified absence can retain the legacy policy; malformed/missing observations remain unavailable. */
export async function readEnvironmentPermissionStartup(port: Pick<EnvironmentPermissionStartupPort, 'read'>): Promise<EnvironmentPermissionStartup> {
  try {
    const observation = await port.read();
    if (observation?.completed === true) return complete();
    if (observation?.completed === false) return pending();
  } catch { /* Raw storage errors and source identities are never startup display text. */ }
  return unknown();
}

/** The token and administrator live only across this approved fixed conversion, never in the returned state. */
export async function prepareEnvironmentPermissionStartup(port: EnvironmentPermissionStartupPort, authority: EnvironmentStartupAuthority): Promise<EnvironmentPermissionStartup> {
  const before = await readEnvironmentPermissionStartup(port);
  if (before.completed !== false) return before;
  try {
    const token = await authority.readToken();
    if (token !== null) {
      const actor = await authority.authenticate(`Bearer ${token}`);
      if (actor !== null && isAdmin(actor)) await port.convert(actor);
    }
  } catch { /* A failed attempt is not proof of rollback or of durable completion. Reobserve below. */ }
  return readEnvironmentPermissionStartup(port);
}

/** Uses only the deployment's stored operator token; CIRCLE_HUB_TOKEN remains refused by serve. */
export function environmentStartupAuthority(
  config: HubConfig,
  env: NodeJS.ProcessEnv,
  principals: Pick<import('../records/api.ts').Principals, 'authenticate'>,
  tokens: (config: HubConfig, service: string) => Pick<OperatorTokenStore, 'read'> = (current, service) => fileOperatorTokens(current.dataDir, service),
): EnvironmentStartupAuthority {
  return {
    authenticate: authorization => principals.authenticate(authorization),
    readToken: async () => (await tokens(config, await deploymentKeyService(env)).read()),
  };
}
