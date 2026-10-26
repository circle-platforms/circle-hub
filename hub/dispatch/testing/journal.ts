// Synthetic request journal: issuer deadlines and sequence identity; remote wall time is recording only.
import { setup } from './context.ts';
import { DispatchService } from '../service.ts';
import { sha256Hex } from '../../records/api.ts';
export async function setupJournal(options: { lost?: boolean|'once'; absent?: boolean; uncertified?: boolean; floorAtDeadline?: boolean; clockBeforeDeadline?: boolean; clockAsText?: boolean; rejected?:boolean; stopped?: boolean; wrongIdentity?: boolean; onSubmit?: () => Promise<void>; deadlinePrecheck?: boolean; pendingReads?: number; identityChange?:'epoch'|'subject'|'since'|'missing'; receiptChange?:boolean; floorBeforeSince?:boolean; supportedVersions?:string[]; deviceReached?:boolean|null; clockLagMs?:number; admitExpired?:boolean; serverVersion?:()=>string; beforeStateChange?:boolean;beforeIdentityMissing?:boolean } = {}) {
  let queries = 0;
  const rows = new Map<string, Record<string, unknown>>();
  let c!: Awaited<ReturnType<typeof setup>>;
  const identity=()=>({epoch:'synthetic-journal',since:(Date.parse('2026-10-23T00:00:00Z')-60000)/1000,principal:{account:'synthetic-account',actor:c.endpoint.calls.at(-1)!.headers['x-circle-hub-actor']}});
  const admit = () => {
    const args = c.endpoint.calls.filter(e => e.params.name === 'send_blob').at(-1)!.params.arguments as Record<string, unknown>;
    const id = String(args.request); const digest = sha256Hex(Buffer.from(String(args.blob),'base64'));
    const previous = rows.get(id);
    if (previous) return previous.digest === digest ? previous.reply as Record<string, unknown> : {...identity(),ok:false,phase:'admission',touched:false};
    const expired = false; // No remote deadline comparison, regardless of wall-clock skew.
    const phase=options.deadlinePrecheck?'precheck':'admission';
    const reply = {...identity(),...(options.receiptChange?{epoch:'replacement-journal'}:{}),ok:!expired,request:id,...(expired ? {phase,touched:false} : {key:'synthetic-remote',digest,ids:args.ids})};
    rows.set(id,{found:true,state:expired ? 'rejected' : 'started',request:id,digest,...(expired ? {phase,touched:false} : {key:'synthetic-remote',touched:true}),reply});
    return reply;
  };
  try {
  c = await setup({serverVersion:options.serverVersion,mode:options.lost==='once'?'disconnect-once':options.lost?'disconnect':undefined,extraTools:['lookup_blob'],onSubmit:async () => { admit(); await options.onSubmit?.(); },alter:(name,value) => {
    if(name==='inspect_slot'&&options.beforeStateChange&&c.calls.includes('send_blob'))return {...value,build:'synthetic-after-write'};
    if (name === 'send_blob') return admit();
    if (name !== 'lookup_blob') return value;
    const args = c.endpoint.calls.filter(e => e.params.name === 'lookup_blob').at(-1)!.params.arguments as Record<string,unknown>;
    const submitted = c.endpoint.calls.filter(e => e.params.name === 'send_blob').at(-1)?.params.arguments as Record<string,unknown> | undefined;
    const deadline = submitted ? Date.parse(String(submitted.until)) : c.clock.ms - 1000;
    const row = rows.get(String(args.request));
    const before=!submitted;
    const original=identity();
    const current=before?{...original,...(options.beforeIdentityMissing?{epoch:undefined}:{})}:{...original,...(options.identityChange==='epoch'?{epoch:'replacement-journal'}:{}),...(options.identityChange==='subject'?{principal:{...original.principal,account:'different-account'}}:{}),...(options.identityChange==='since'?{since:original.since+1}:{}),...(options.identityChange==='missing'?{epoch:undefined}:{})};
    if (!row || options.absent) return {...current,found:false,clock:!before && options.clockAsText ? '9999' : (before?c.clock.ms-(options.clockLagMs??0):(!before && options.clockBeforeDeadline ? deadline : deadline+1))/1000,floor:!before && options.floorBeforeSince?original.since-1:(!before && options.floorAtDeadline ? deadline/1000 : original.since)};
    if(++queries <= (options.pendingReads ?? 0))return {...row,...current,state:'received',key:undefined,touched:null};
    return {ok:true,...row,...current,...(options.rejected?{state:'rejected',phase:'admission',touched:false,key:undefined}:{}),...(Object.hasOwn(options,'deviceReached')?{touched:options.deviceReached}:{}),...(options.stopped ? {state:'not_started',touched:Object.hasOwn(options,'deviceReached')?options.deviceReached:false,key:undefined} : {}),...(options.wrongIdentity ? {request:'other-request'} : {})};
  }});
  c.service = new DispatchService({...c.service.options,sleep:async ms=>{ c.clock.ms += ms; }});
  const proof = await c.kit.artifacts.ingest({bytes:new TextEncoder().encode('synthetic certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
  const registered = await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,
    allowed_tools:[...c.executor.definition.allowed_tools,'lookup_blob'],
    calls:{...c.executor.definition.calls,query:{tool:'lookup_blob',arguments:{request:{$value:'request_id'},ticket:{$value:'lease_id'}}}},
    receipt:{...c.executor.definition.receipt,identity:{epoch:'/epoch',since:'/since',subject:'/principal'},stage:'/phase',reached_device:'/touched',stages:{admission:'target_rejected',precheck:'target_rejected'}},
    reconciliation:{identity:{epoch:'/epoch',since:'/since',subject:'/principal'},protocol_versions:options.supportedVersions??['1'],pending_states:['received','starting'],found:'/found',state:'/state',request_id:'/request',sha256:'/digest',id:'/key',stage:'/phase',reached_device:'/touched',gateway_time:'/clock',gc_before:'/floor',time_scale_ms:1000,map:{started:'issued',rejected:'target_rejected',not_started:'proven_not_executed'}},
    conformance:{expected_stage:'admission',payloads:[Buffer.from('synthetic-one').toString('base64'),Buffer.from('synthetic-two').toString('base64')]},
    premises: options.uncertified ? {} : {request_journal:{version:'1',evidence:[`src:${proof.body.sha256}`]}} });
  await c.freezeExecutor();
  return {...c,registered,proof,rows};
  } catch(error) { if(c)await c.close();throw error; }
}
