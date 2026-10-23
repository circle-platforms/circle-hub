import type { Principal, RecordsKit } from '../records/api.ts';
import type { RunDetail, RunsService, WorkflowStore } from '../ports.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import { canonicalize, isSha256 } from '../records/api.ts';
import { at, type ExecutorDefinition } from './definition.ts';
export type VerificationPort = Pick<RunsService, 'getRun'>;
export interface VerifiedInput {
  run: string; user: string; lineage: string; ancestors: string[]; item: string; items: string[];
  plan_run: string; sha256: string; target: string; manifest_sha256: string; build: string; generator: unknown; result: string;
}
function validClaim(c: Claim, now: Date): boolean {
  return c.statement.verdict === 'support' && c.validity.status === 'valid' && (!c.validity.expires_at || Date.parse(c.validity.expires_at) > now.getTime());
}
export async function verifyInput(by: Principal, id: string, d: ExecutorDefinition, records: RecordsKit, runs: VerificationPort, workflows: Pick<WorkflowStore, 'byDigest'>, now: Date): Promise<VerifiedInput> {
  const detail = await runs.getRun(by, id);
  if (!detail?.run.runner || detail.run.pack.split('@')[0] !== d.proof.package || detail.latest?.result.acceptance !== 'accepted') throw new Error('派发前提未满足：要求指定包的最近受理核验运行');
  const workflow = await workflows.byDigest(detail.run.pack_digest);
  if (!workflow || `${workflow.pack.id}@${workflow.pack.version}` !== detail.run.pack || workflow.pack.digest !== detail.run.pack_digest) throw new Error('核验运行锁定的任务包不可用');
  const result = detail.latest.result;
  if (result.run !== id || result.errors.length || Object.entries(result.partitions).some(([key, list]) => key !== 'delivered' && list.length)) throw new Error('运行没有完整满足派发前提');
  const projected = detail.run.items.map(i => i.id).sort();
  if (projected.length !== 1) throw new Error('本轮核验运行必须明确一个目标条目；请按目标条目重开核验运行');
  if (canonicalize(projected) !== canonicalize(result.partitions.delivered.map(i => i.item).sort())) throw new Error('核验结果未覆盖全部条目');
  const required = workflow.requirements.filter(r => r.required);
  for (const r of required) {
    if (r.target === 'item') {
      if (result.partitions.delivered.some(i => i.requirements.find(v => v.requirement === r.key)?.status !== 'satisfied')) throw new Error('核验运行仍有必需要求项未满足');
    } else {
      const claims = result.cross_item.filter(c => c.requirement === r.key);
      if (!claims.length || claims.some(c => !validClaim(c, now))) throw new Error('核验运行仍有运行级必需要求项未满足');
    }
  }
  const proofRequirement = required.find(r => r.key === d.proof.requirement);
  if (!proofRequirement || proofRequirement.accepted_producer !== 'fact') throw new Error('派发要求项不是必需的事实要求项');
  const claims = [...result.cross_item, ...result.partitions.delivered.flatMap(i => i.requirements.filter(r => r.requirement === d.proof.requirement).flatMap(r => r.claims))]
    .filter(c => c.requirement === d.proof.requirement && c.qualifier.nature === 'fact' && c.warrant.producer === 'function' && validClaim(c, now));
  if (!claims.length || claims.some(c => canonicalize(c.statement.data ?? null) !== canonicalize(claims[0].statement.data ?? null))) throw new Error('缺少一致且有效的派发核验事实');
  const data = claims[0].statement.data;
  const planRun = at(data, d.proof.plan_run);
  if (typeof planRun !== 'string' || !planRun || planRun !== detail.run.predecessor) throw new Error('用计划运行作 predecessor 重开核验运行');
  const sha256 = at(data, d.proof.sha256); const ids = at(data, d.proof.items); const target = at(data, d.proof.target);
  const manifest = at(data, d.proof.manifest_sha256); const build = at(data, d.proof.build); const generator = at(data, d.proof.generator);
  if (typeof sha256 !== 'string' || !isSha256(sha256) || !Array.isArray(ids) || ids.length !== 1 || ids.some(v => typeof v !== 'string' || !v || v.length > 200) || new Set(ids).size !== ids.length || typeof target !== 'string' || typeof manifest !== 'string' || !isSha256(manifest) || typeof build !== 'string' || !build || generator === undefined || generator === null) throw new Error('核验事实的派发身份字段不完整；本轮只允许一个条目');
  const sourceHas = (sha: string) => detail.run.sources.some(s => new RegExp(`^src:${sha}(?:/|$)`).test(s.reference));
  if (!detail.run.sources.some(s => s.slot === d.proof.slot && s.role === 'artifact_under_verification' && new RegExp(`^src:${sha256}(?:/|$)`).test(s.reference))) throw new Error('核验字节不在执行器声明的待判定产物槽位；请重开核验运行');
  if (!sourceHas(sha256) || !sourceHas(manifest)) throw new Error('核验事实的字节或清单没有绑定到该运行');
  if (target !== d.target || manifest !== d.manifest_sha256) throw new Error(`台架名或清单身份不符：核验清单 ${manifest}，执行器期望 ${d.manifest_sha256} 不符；下一步：用当前清单重跑核验运行`);
  if (detail.run.build !== undefined && detail.run.build !== build) throw new Error('核验事实构建与运行锁定构建不符；请重跑核验');
  const owner = await records.principals.get(detail.run.runner);
  if (!owner || owner.disabled) throw new Error('核验运行的发起用户不可用');
  const ancestors: string[] = []; let ancestor: RunDetail | null = detail;
  while (ancestor) {
    if (ancestors.includes(ancestor.run.run) || ancestors.length >= 100 || ancestor.run.runner !== owner.id) throw new Error('运行血缘不可验证');
    ancestors.push(ancestor.run.run);
    const predecessor: string | undefined = ancestor.run.predecessor;
    ancestor = predecessor ? await runs.getRun(by, predecessor) : null;
    if (predecessor && !ancestor) throw new Error('预订前驱不可读取');
  }
  return { run: id, plan_run: planRun, user: owner.id, lineage: ancestors.at(-1)!, ancestors, item: detail.run.items[0].id, items: ids as string[], sha256, target, manifest_sha256: manifest, build, generator, result: detail.latest.record };
}
