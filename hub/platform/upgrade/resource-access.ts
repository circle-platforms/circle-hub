// This conversion is only for the verified predecessor: its reader exposed enabled resources to every enabled account.
import { ResourceId, ResourceRecord } from '../../../contracts/src/resources.ts';
import { sha256Hex, type Principal, type Principals, type RecordsKit } from '../../records/api.ts';
import { fields, type OldRecord, type UpgradeIssue } from './state.ts';

export interface ResourceAccessPlan { resources: string[]; issues: UpgradeIssue[]; }
export async function previousResourceAccess(records: readonly OldRecord[], readObject: (hash: string) => Promise<Uint8Array | null>, now: Date): Promise<ResourceAccessPlan> {
  const latest = new Map<string, OldRecord>(), definitions = new Map<string, OldRecord>(), explicit = new Set<string>();
  const issues: UpgradeIssue[] = [], resources: string[] = [];
  for (const row of [...records].sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : 1)) {
    if (row.kind !== 'authorization' || row.body === undefined) continue;
    const body = fields(row.body);
    if (body.permission === 'resource_assign' && typeof body.object === 'string') explicit.add(body.object);
    if (body.permission !== 'resource_config' || body.subject !== '*' || !ResourceId.safeParse(body.object).success) continue;
    const id = String(body.object);
    if (!latest.has(id)) latest.set(id, row);
    if (!definitions.has(id) && body.revoked === false && typeof body.bound === 'string') definitions.set(id, row);
  }
  for (const [id, decision] of latest) {
    const body = fields(decision.body);
    if (body.revoked || body.expires_at !== null && Date.parse(String(body.expires_at)) <= now.getTime() || explicit.has(id)) continue;
    try {
      const definition = definitions.get(id);
      if (!definition) throw new Error();
      const bound = fields(definition.body).bound;
      if (typeof bound !== 'string') throw new Error();
      const bytes = await readObject(bound);
      if (!bytes || sha256Hex(bytes) !== bound) throw new Error();
      // The predecessor's strict ResourceRecord has no private/ACL scope. Unknown extra fields fail instead of widening.
      const resource = ResourceRecord.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
      if (resource.id !== id) throw new Error();
      resources.push(id);
    } catch { issues.push({ table: 'resource_access', row: records.indexOf(decision) + 1, reason: '旧资源定义或可用范围不能按已核对的上一发行规则确认，未扩大访问' }); }
  }
  return { resources, issues };
}

export async function convertPreviousResourceAccess(records: RecordsKit, plan: ResourceAccessPlan, getActor: (principals: Pick<Principals, 'list' | 'get'>) => Promise<Principal>): Promise<number> {
  if (plan.issues.length) throw new Error('旧资源访问范围未确认，不能转换');
  if (!plan.resources.length) return 0;
  const actor = await getActor(records.principals);
  for (const resource of plan.resources) await records.authorizations.assignResource(actor, resource, '*', { note: '按上一发行实际全体访问规则在升级时转换' });
  return plan.resources.length;
}
