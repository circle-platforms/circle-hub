import {ExecutorSource} from '../../contracts/src/resources.ts';
// Member-visible environment assignments and booking admission; source identities stay inside the Hub.
import {type TestEnvironment} from '../../contracts/api.ts';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { sha256Hex, isAdmin, type Principal, type RecordsKit, type Transaction } from '../records/api.ts';
import type { LeaseService } from '../leases/api.ts';
import type { ExecutorRegistry } from './executors.ts';

export type EnvironmentPermission = (actor: Principal, executor: string, tx?: Transaction) => Promise<boolean>;
export interface MemberEnvironment {
  name: string;
  enabled: boolean;
  assigned: boolean;
  can_use: boolean;
  occupancy: Array<{ name: string; since: string; until: string | null; mine: boolean }> | null;
  missing: string[];
}

export interface UnattributedHolding {
  booking_run: string;
  since: string;
  until: string | null;
  target: null;
  assigned: false;
  can_use: false;
  assignment_reason: string;
  target_missing: string;
}

export class MemberEnvironments {
  readonly records: Pick<RecordsKit, 'testEnvironments' | 'artifacts' | 'objects' | 'principals'>;
  readonly registry: Pick<ExecutorRegistry, 'readSource'>;
  readonly leases: Pick<LeaseService, 'view' | 'registrations'>;
  constructor(
    records: Pick<RecordsKit, 'testEnvironments' | 'artifacts' | 'objects' | 'principals'>,
    registry: Pick<ExecutorRegistry, 'readSource'>,
    leases: Pick<LeaseService, 'view' | 'registrations'>,
  ) {
    this.records = records; this.registry = registry; this.leases = leases;
  }

  inheritance(tx?:Transaction) { return this.records.testEnvironments.inheritance(tx); }

  private covers(environment:TestEnvironment, key:string):boolean {
    return environment.resources.some(row=>row.key===key) || environment.prefixes.some(row=>key.startsWith(row.prefix));
  }

  /** Resolve every key in the complete catalog before consulting any grants. */
  private async environments(keys:readonly string[],tx?:Transaction):Promise<TestEnvironment[]|null> {
    if(!keys.length)return null;
    const environments=new Map<string,TestEnvironment>();
    for(const key of new Set(keys)) {
      const matches=await this.records.testEnvironments.resolve([key],tx);
      if(matches.length!==1 || matches[0].target===null)return null;
      environments.set(matches[0].id,matches[0]);
    }
    return [...environments.values()];
  }

  /** Fresh executor bytes and catalog membership are both checked in the caller's transaction. */
  readonly permission:EnvironmentPermission = async(actor,executor,tx)=>{
    const snapshot=await this.records.artifacts.capturePermissionSnapshot?.(actor,tx);
    const config=snapshot?.latest('resource_config','*','executor.'+executor);
    if(!snapshot?.user || snapshot.user.disabled || snapshot.user.deleted_at || !config || !snapshot.enabled(config) || !config.body.bound)return false;
    const bytes=await this.records.objects.get(config.body.bound,tx);
    if(!bytes || sha256Hex(bytes)!==config.body.bound)throw new Error('测试环境关联执行器的登记原件不可核对');
    const source=ExecutorSource.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if(source.id!==executor || !source.enabled)return false;
    const environments=await this.environments(source.resources,tx);
    if(!environments || environments.length!==1)return false;
    const environment=environments[0];
    if(!environment.enabled || !environment.executors.includes(executor) || environment.target!==source.target)return false;
    return this.records.testEnvironments.canUse(actor,environment.id,tx);
  };

  async canUse(actor:Principal,executor:string):Promise<boolean> { return this.permission(actor,executor); }

  async authorizeKeys(actor: Principal, keys: readonly string[],tx?:Transaction): Promise<ProtocolError | null> {
    const environments=await this.environments(keys,tx);
    if(environments) {
      let allowed=true;
      for(const environment of environments) if(!environment.enabled || !await this.records.testEnvironments.canUse(actor,environment.id,tx))allowed=false;
      if(allowed)return null;
    }
    return {code:'SOURCE_NOT_PERMITTED',message:'没有分配这些资源对应的唯一启用测试环境，不能预订或续期',fix:'请管理员核对测试环境登记和分配；目标归属不明确时不能开始新的使用'};
  }

  private async assigned(actor:Principal):Promise<TestEnvironment[]> {
    const snapshot=await this.records.artifacts.capturePermissionSnapshot?.(actor);
    if(!snapshot?.user || snapshot.user.disabled || snapshot.user.deleted_at)return [];
    const subjects=[snapshot.user.id,...snapshot.teams(),'*'];
    return (await this.records.testEnvironments.list(actor)).filter(environment=>subjects.some(subject=>snapshot.enabled(snapshot.latest('resource_assign',subject,environment.id))));
  }

  async list(actor: Principal): Promise<MemberEnvironment[]> {
    const viewer = (await this.records.artifacts.capturePermissionSnapshot?.(actor))?.user;
    if (!viewer || viewer.disabled || viewer.deleted_at) return [];
    const out: MemberEnvironment[] = [];
    for (const environment of await this.assigned(actor)) {
      if(environment.name===null || environment.target===null)continue;
      const row: MemberEnvironment = { name: environment.name, enabled: environment.enabled, assigned: true, can_use: environment.enabled && await this.records.testEnvironments.canUse(actor,environment.id), occupancy: null, missing: [] };
      try {
        const entries = (await this.leases.view('', true)).entries.filter(lease => this.covers(environment,lease.key));
        const occupants = new Map<string, NonNullable<MemberEnvironment['occupancy']>[number]>();
        for (const lease of entries) {
          const visible = lease.user === viewer.id || isAdmin(viewer) || environment.prefixes.some(registration => registration.owner === viewer.id && lease.key.startsWith(registration.prefix)) || environment.resources.some(resource=>resource.owner===viewer.id && resource.key===lease.key);
          const account = visible ? await this.records.principals.get(lease.user) : null;
          occupants.set([lease.user, lease.run, lease.since, lease.until].join('\0'), {
            name: account && !account.deleted_at ? account.name : '其他成员',
            since: lease.since, until: lease.until, mine: lease.user === actor.id,
          });
        }
        row.occupancy = [...occupants.values()];
      } catch {
        row.missing.push('当前租约占用未能读取，请稍后重读');
      }
      row.missing.push('租约记录不等于远端作业或物理环境状态；没有租约不代表环境空闲');
      if (!environment.enabled) row.missing.push('测试环境已停用，请管理员核对后启用');
      out.push(row);
    }
    return out;
  }

  /** A lease key is not an executor binding; never infer a target for an unassigned booking. */
  async unattributedHoldings(actor: Principal): Promise<UnattributedHolding[] | null> {
    try {
      if (!this.records.artifacts.capturePermissionSnapshot) return null;
      const viewer = (await this.records.artifacts.capturePermissionSnapshot(actor)).user;
      if (!viewer || viewer.disabled || viewer.deleted_at) return [];
      const held = (await this.leases.view('', true)).entries.filter(lease => lease.user === viewer.id);
      if (!held.length) return [];
      const assigned = await this.assigned(actor);
      const holdings = new Map<string, UnattributedHolding>();
      for (const lease of held) {
        if (assigned.some(environment=>this.covers(environment,lease.key))) continue;
        holdings.set([lease.run, lease.since, lease.until].join('\0'), {
          booking_run: lease.run, since: lease.since, until: lease.until,
          target: null, assigned: false, can_use: false,
          assignment_reason: '当前没有分配，不能续期或开始新的上机验证；预订仍由当前账户持有',
          target_missing: '预订没有可核验的执行器绑定，目标归属未知',
        });
      }
      return [...holdings.values()];
    } catch {
      return null;
    }
  }

}
