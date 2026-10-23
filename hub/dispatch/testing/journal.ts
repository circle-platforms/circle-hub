// Synthetic request journal matching the pre-admission, deadline and cached-reply behavior.
import { setup } from './context.ts';
import { DispatchService } from '../service.ts';
import { sha256Hex } from '../../records/api.ts';
export async function setupJournal(options: { lost?: boolean; absent?: boolean; uncertified?: boolean; floorAtDeadline?: boolean; clockBeforeDeadline?: boolean; stopped?: boolean; wrongIdentity?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  let c: Awaited<ReturnType<typeof setup>>;
  const admit = () => {
    const args = c.endpoint.calls.filter(e => e.params.name === 'send_blob').at(-1)!.params.arguments as Record<string, unknown>;
    const id = String(args.request); const digest = sha256Hex(Buffer.from(String(args.blob),'base64'));
    const previous = rows.get(id);
    if (previous) return previous.digest === digest ? previous.reply as Record<string, unknown> : {ok:false,phase:'admission',touched:false};
    const expired = Date.parse(String(args.until)) <= c.clock.ms;
    const reply = {ok:!expired,request:id,...(expired ? {phase:'admission',touched:false} : {key:'synthetic-remote',digest,ids:args.ids})};
    rows.set(id,{found:true,state:expired ? 'rejected' : 'started',request:id,digest,...(expired ? {phase:'admission',touched:false} : {key:'synthetic-remote',touched:true}),reply});
    return reply;
  };
  c = await setup({mode: options.lost ? 'disconnect' : undefined,extraTools:['lookup_blob'],onSubmit:async () => { admit(); },alter:(name,value) => {
    if (name === 'send_blob') return admit();
    if (name !== 'lookup_blob') return value;
    const args = c.endpoint.calls.filter(e => e.params.name === 'lookup_blob').at(-1)!.params.arguments as Record<string,unknown>;
    const submitted = c.endpoint.calls.filter(e => e.params.name === 'send_blob').at(-1)?.params.arguments as Record<string,unknown> | undefined;
    const deadline = submitted ? Date.parse(String(submitted.until)) : c.clock.ms - 1000;
    const row = rows.get(String(args.request));
    if (!row || options.absent) return {found:false,clock:(options.clockBeforeDeadline ? deadline : deadline+1)/1000,floor:(options.floorAtDeadline ? deadline : 0)/1000};
    return {...row,...(options.stopped ? {state:'not_started',touched:false,key:undefined} : {}),...(options.wrongIdentity ? {request:'other-request'} : {})};
  }});
  c.service = new DispatchService({...c.service.options,sleep:async ms=>{ c.clock.ms += ms; }});
  const proof = await c.kit.artifacts.ingest({bytes:new TextEncoder().encode('synthetic certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
  const registered = await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,
    allowed_tools:[...c.executor.definition.allowed_tools,'lookup_blob'],
    calls:{...c.executor.definition.calls,query:{tool:'lookup_blob',arguments:{request:{$value:'request_id'}}}},
    receipt:{...c.executor.definition.receipt,stage:'/phase',reached_device:'/touched',stages:{admission:'target_rejected'}},
    reconciliation:{found:'/found',state:'/state',request_id:'/request',sha256:'/digest',id:'/key',stage:'/phase',reached_device:'/touched',gateway_time:'/clock',gc_before:'/floor',time_scale_ms:1000,map:{started:'issued',rejected:'target_rejected',not_started:'proven_not_executed'}},
    conformance:{payloads:[Buffer.from('synthetic-one').toString('base64'),Buffer.from('synthetic-two').toString('base64')]},
    premises: options.uncertified ? {} : {request_journal:{version:'1',evidence:[`src:${proof.body.sha256}`]}} });
  return {...c,registered,proof,rows};
}
