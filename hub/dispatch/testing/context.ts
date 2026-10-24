import {effectsDocument} from './effects.ts';
import {boundaryPolicy} from '../policy.ts';
import {addSyntheticExecutor} from './credentials.ts';
import { after } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openTestRecords } from '../../testing/records.ts';
import { newId, sha256Hex, canonicalBytes } from '../../records/api.ts';
import { createPool, Database } from '../../records/db.ts';
import { LeaseService } from '../../leases/api.ts';
import type { RunDetail, WorkflowStore, LoadedWorkflow } from '../../ports.ts';
import { ExecutorRegistry } from '../executors.ts';
import { DispatchService } from '../service.ts';
import { definition } from './definition.ts';
import { startEndpoint } from './server.ts';
import {probes} from './probes.ts';

let cluster:Promise<TemporaryPostgres>|undefined;
after(async()=>{if(cluster)await cluster.then(pg=>pg.stop()).catch(()=>{});});

export async function setup(options: { mode?: string; alter?: (name: string, value: Record<string, unknown>) => Record<string, unknown>; onSubmit?: () => Promise<void>; timeout?: number; ttl?: number; extraTools?: string[]; serverVersion?:()=>string; delay?: Record<string,number> } = {}) {
  const clock = { ms: Date.parse('2026-10-23T00:00:00.000Z') };
  const now = () => new Date(clock.ms);
  const kit = await openTestRecords({ now, postgres: await (cluster ??= startPostgres()) });
  const db = new Database(createPool(kit.database, 4));
  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  try {
  const leases = new LeaseService(db, { now: async () => now() });
  const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
  const owner = await kit.principals.createUser(admin, '合成运行者');
  const run = newId('run'); const plan = newId('run');
  const payload = await kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic verified bytes'), mediaType: 'application/octet-stream', origin: { upload: { session: 'synthetic' } }, author: { user: owner.id }, provenanceType: 'declared', visibility: { readers: [owner.id], admins: true, packs: [], shareable: false } });
  const manifest = await kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', resources: definition('x').resources,devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]})) }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: owner.id }, provenanceType: 'declared', visibility: { readers: [owner.id], admins: true, packs: [], shareable: false } });
  let failedSubmit=false;let failedRead = false; let stateReads = 0; let sawIntentAtSubmit = false;
  const calls: string[] = [];
  const submitted: Uint8Array[] = [];
  let submittedRequest: unknown; let submittedSha = payload.body.sha256; let submittedIds: unknown = ['synthetic-case'];
  const replies = (name: string): Record<string, unknown> => {
    if (name === 'open_slot') return { ok: options.mode !== 'busy', ticket: 'synthetic-ticket', token: 'synthetic-token', ttl: options.ttl ?? 30000 };
    if (name === 'touch_slot') return { ok: options.mode !== 'heartbeat-failure', ticket: 'synthetic-ticket', token: 'synthetic-token', ttl: options.ttl ?? 30000 };
    if (name === 'inspect_slot') return { build: options.mode === 'build' ? 'wrong' : 'synthetic-build', seats: options.mode === 'seats' ? 0 : 2, reachable: true, topology: { synthetic: true } };
    if (name === 'send_blob') return { request: submittedRequest, ok: options.mode !== 'reject', key: 'synthetic-remote', digest: options.mode === 'receipt-sha' ? 'f'.repeat(64) : submittedSha, ids: options.mode === 'receipt-items' ? ['different'] : submittedIds };
    if (name === 'inspect_blob') return { state: options.mode === 'lost' ? 'vanished' : options.mode === 'unmapped' ? 'unmapped' : ++stateReads <= 2 ? 'working' : 'ended', exit: 0 };
    if (name === 'read_blob') return { request: submittedRequest, key: 'synthetic-remote', digest: options.mode === 'result-sha' ? 'f'.repeat(64) : submittedSha, submitted: now().toISOString(), rows: options.mode === 'partial' ? [] : [{ id: 'synthetic-case', outcome: 'good' }], complete: options.mode !== 'partial' };
    return { ok: true };
  };
  endpoint = await startEndpoint([...definition('x').allowed_tools, 'inspect_bound_seat', ...(options.extraTools ?? [])], async (name, _args, res) => {
    calls.push(name);
    if(options.delay?.[name])await new Promise(resolve=>setTimeout(resolve,options.delay![name]));
    if(name==='inspect_bound_seat'){const value={output:_args.command==='inspect version'?'version: synthetic-build':`address: 192.0.2.${Number(_args.seat)+1}/24`};return options.alter?.(name,value)??value;}
    if (options.mode === 'fencing-result' && name === 'read_blob') await leases.forceRelease({ keys: definition('x').resources, by: admin.id, reason: '合成结果阶段强制释放' });
    if (!failedRead && ((options.mode === 'transient-status' && name === 'inspect_blob') || (options.mode === 'transient-result' && name === 'read_blob'))) { failedRead = true; res.destroy(); return {}; }
    if (name === 'send_blob') {
      submittedRequest = _args.request;
      const bytes = Buffer.from(String(_args.blob), 'base64'); submitted.push(bytes); submittedSha = sha256Hex(bytes); submittedIds = _args.ids;
      if (_args.digest !== submittedSha) return { ok: false };
      sawIntentAtSubmit = (await kit.store.getByKey('action', `dispatch.bytes:${submittedSha}:1`)) !== null;
      if (options.onSubmit) await options.onSubmit();
      if (options.mode === 'disconnect'||options.mode==='disconnect-once'&&!failedSubmit) { failedSubmit=true;res.destroy(); return {}; }
      if (options.mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 80));
      if (options.mode === 'fencing') await leases.forceRelease({ keys: definition('x').resources, by: admin.id, reason: '合成强制释放' });
    }
    return options.alter?.(name, replies(name)) ?? replies(name);
  },undefined,{},options.serverVersion);
  const registry = new ExecutorRegistry(kit);
  const d = { ...definition(endpoint.endpoint),allowed_tools:[...definition(endpoint.endpoint).allowed_tools,'inspect_bound_seat'],refused_tools:['synthetic_admin_reset'],probes:{...probes,call:{...probes.call,tool:'inspect_bound_seat'}}, manifest_sha256: manifest.body.sha256, submit_timeout_ms: options.timeout ?? 300000 };
  const executor = await addSyntheticExecutor(kit,registry,admin,d,'synthetic-secret');
  const claim = { requirement: 'workbook_verified', statement: { verdict: 'support', text: '合成核验', data: { plan_run: plan, sha256: payload.body.sha256, autoids: ['synthetic-case'], bed: { id: 'synthetic-bed', manifest_sha256: options.mode === 'manifest' ? 'f'.repeat(64) : manifest.body.sha256 }, build: 'synthetic-build', generator: 'synthetic-workflow@1.0.0' } }, qualifier: { nature: 'fact' }, warrant: { producer: 'function', id: 'synthetic.verify@1' }, validity: { status: 'valid' } };
  const detail = { run: { run, predecessor: plan, pack: options.mode === 'wrong-package' ? 'other-workflow@1.0.0' : 'synthetic-workflow@1.0.0', pack_digest: sha256Hex('synthetic-pack'), runner: owner.id, items: [{ id: 'synthetic-item' }], sources: [{ reference: `src:${payload.body.sha256}`, slot: 'synthetic-artifact', role: 'artifact_under_verification' }, { reference: `src:${manifest.body.sha256}`, slot: 'synthetic-manifest', role: 'expected' }], requirements: [], started_at: now().toISOString() }, submissions: [], latest: { record: sha256Hex('synthetic-validation'), result: { run, acceptance: 'accepted', errors: [], partitions: { delivered: [{ item: 'synthetic-item', requirements: [{ requirement: 'workbook_verified', status: options.mode === 'requirement' ? 'pending' : 'satisfied', claims: [claim] }] }], rejected: [], incomplete: [], quarantined: [] }, cross_item: [] } } } as unknown as RunDetail;
  const effectDocument=effectsDocument({target:'synthetic-bed',manifest_sha256:manifest.body.sha256,build:'synthetic-build',sha256:payload.body.sha256,items:['synthetic-case'],generator:'synthetic-workflow@1.0.0'});
  const freezeExecutor=async()=>{detail.run.policy=(await boundaryPolicy()).version;detail.run.executors=(await kit.objects.put(canonicalBytes({[executor.id]:(await registry.get(executor.id))!.resolved_digest}),'application/json')).sha256;};await freezeExecutor();
  const workflows = { byDigest: async () => ({ pack: { id: 'synthetic-workflow', version: '1.0.0', digest: detail.run.pack_digest }, requirements: [{ key: 'workbook_verified', required: true, target: 'item', accepted_producer: 'fact' }],readJson:async()=>effectDocument } as unknown as LoadedWorkflow) } satisfies Pick<WorkflowStore, 'byDigest'>;
  const runs = { getRun: async (_by: unknown, id: string) => id === run ? detail : id === plan ? { ...detail, run: { ...detail.run, run: plan, predecessor: undefined } } : null };
  await leases.acquire({ keys: d.resources, prefix: 'synthetic/', ttlSeconds: options.mode === 'expiry' ? 1 : 3600, maxTtlSeconds: 3600, holder: { user: owner.id, run: options.mode === 'lineage' ? newId('run') : run } });
  const service = new DispatchService({ recheckChecks:async({checks})=>Object.fromEntries(checks.map(id=>[id,[{verdict:'support',statement:'合成政策通过',grounds:[],tier:'blocking',data:{parameters:Object.fromEntries(Object.entries(effectDocument.effects[0].parameters.values).map(([key,values])=>[key,values[0]]))}}]])),records: kit, leases, runs, workflows, now });
  const server=endpoint;let closing:Promise<void>|undefined;
  return { effectDocument,freezeExecutor,kit, db, clock, now, admin, owner, run, detail, workflows, runs, executor, registry, leases, service, calls, submitted, endpoint:server, payload,
    get sawIntentAtSubmit() { return sawIntentAtSubmit; },
    close: () => (closing ??= (async () => { await server.close(); await db.end(); await kit.close(); })()) };
  } catch(error) { await endpoint?.close().catch(()=>{});await db.end().catch(()=>{});await kit.close();throw error; }
}
