import {EffectRecord} from '../../contracts/src/resources.ts';
import {isEffectOutcome} from '../../contracts/generated/vocabulary.ts';
import type { ActionBody, Principal, RecordsKit, StoredRecord, Transaction } from '../records/api.ts';
import type { ActionKind, ActionResult } from '../../contracts/generated/vocabulary.ts';
import { newId, sha256Hex, canonicalBytes } from '../records/api.ts';
import type { HolderSnapshot } from '../leases/api.ts';
import type { VerifiedInput } from './proof.ts';
export interface JobBinding { run?:string; job: string; initiated_by: string; acting_by?: string; executor: string; executor_digest: string; executor_source_digest?:string; variables?:import('../../contracts/src/variables.ts').VariableUse[]; target_key: string; scope?: {target:string;origin:string}; input: VerifiedInput | null; user: string; resources: string[]; fences?: HolderSnapshot[]; context?: Record<string, unknown>; }
export type Event = StoredRecord<ActionBody>;
export class Journal {
  readonly records: RecordsKit;
  readonly now: () => Date;
  constructor(records: RecordsKit, now: () => Date) { this.records = records; this.now = now; }
  /** A durable per-executor ordinal; gaps are allowed, reuse or rollback is not. */
  async nextDispatchSequence(binding: JobBinding): Promise<number> {
    return this.records.store.withTransaction(async tx => {
      await this.records.store.lock(`dispatch.ordinal:${binding.executor}`, tx);
      const rows = await this.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.sequence.executor',values:[binding.executor]},tx);
      const previous = rows.reduce((max,row) => Math.max(max,Number(row.body.detail.dispatch_sequence)),0);
      const sequence = previous + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error('派发序号已耗尽；未提交，请管理员建立新执行器身份并重新核验');
      await this.append(binding,'dispatch_ordinal','validate','completed',{dispatch_sequence:sequence},[],`dispatch.ordinal:${binding.executor}:${sequence}`,tx);
      return sequence;
    });
  }
  async events(job: string,tx?:Transaction): Promise<Event[]> { return this.records.store.findMany<ActionBody>({ key: 'dispatch.job', values: [job], kind: 'action' },tx); }
  async targets(resources: readonly string[]): Promise<Event[]> { return this.records.store.findMany<ActionBody>({ key: 'dispatch.resource', values: resources.map(r => sha256Hex(r)), kind: 'action' }); }
  async blockers(executor:string,target:string,origin:string,resources:readonly string[]):Promise<string[]> {
    // Discover legacy reservations too, then inspect complete histories in bounded batches. A phase allow-list
    // drops terminal/refreeze/answer records and cannot establish whether a physical reservation still owns anything.
    const reservations=await this.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.phase',values:['reservation']});
    const candidates=new Map<string,JobBinding>();
    for(const reservation of reservations){const b=reservation.body.detail.binding as JobBinding|undefined;
      if(!b||candidates.has(b.job))continue;
      let matches=b.executor===executor||b.resources.some(key=>resources.includes(key))||(b.scope?.target??b.input?.target)===target||b.scope?.origin===origin;
      if(!matches&&!b.scope){const bytes=await this.records.objects.get(b.executor_digest);if(!bytes)matches=true;else{const d=JSON.parse(new TextDecoder().decode(bytes));matches=d.target===target||new URL(d.endpoint).origin===origin;}}
      if(matches)candidates.set(b.job,b);
    }
    const blocked:string[]=[],jobs=[...candidates.keys()];
    for(let offset=0;offset<jobs.length;offset+=128){
      const batch=jobs.slice(offset,offset+128),events=await this.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.job',values:batch});
      const histories=new Map<string,Event[]>();
      for(const event of events){const job=String(event.body.detail.job),history=histories.get(job)??[];history.push(event);histories.set(job,history);}
      for(const job of batch)if(holdsPhysicalTarget(histories.get(job)??[]))blocked.push(job);
    }
    return blocked;
  }
  async append(binding: JobBinding, phase: string, action: ActionKind, result: ActionResult, detail: Record<string, unknown> = {}, inputs: string[] = [], unique_key?: string, tx?: Transaction, errorCode:ActionBody['error_code']=null) {
    const time = this.now().toISOString();
    const event=await this.records.store.put<ActionBody>({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: time,
      body: { action, run: binding.input?.run ?? binding.run ?? null, item: binding.input?.item ?? null, inputs, component: 'dispatch@1', lease: binding.fences?.length ? { lease: binding.fences[0].lease, fencing: binding.fences[0].fencing } : null, started_at: typeof detail.started_at === 'string' ? detail.started_at : time, ended_at: typeof detail.ended_at === 'string' ? detail.ended_at : time, result,
        error_code: result==='error'?errorCode:null, acceptance: phase==='intent' || phase === 'gate' && detail.allow_submit === true ? 'accepted' : null, codes: result==='error' && errorCode?[errorCode]:[], detail: { job: binding.job, initiated_by: binding.initiated_by, acting_by: binding.acting_by ?? binding.initiated_by, phase, event: newId('evt'), ...detail } },
      index: [...(phase==='dispatch_ordinal'?[{key:'dispatch.sequence.executor',value:binding.executor}]:[]),{ key: 'dispatch.job', value: binding.job }, { key: 'dispatch.phase', value: phase }, { key: 'dispatch.target', value: binding.target_key },{key:'dispatch.executor',value:binding.executor},...(binding.scope?[{key:'dispatch.scope.target',value:sha256Hex(binding.scope.target)},{key:'dispatch.scope.origin',value:sha256Hex(binding.scope.origin)}]:[]), ...binding.resources.map(r => ({ key: 'dispatch.resource', value: sha256Hex(r) })),
        ...(phase==='intent'&&typeof detail.effect_row==='string'?[{key:'dispatch.effect_row',value:`${binding.input!.run}:${detail.effect_row}`}]:[]),
        ...(binding.input ? [{ key: 'dispatch.lineage', value: binding.input.lineage }, ...(phase === 'intent' ? [{ key: 'dispatch.bytes', value: binding.input.sha256 }] : [])] : [])], ...(unique_key ? { unique_key } : {}) }, tx);
    if(event.created&&(phase==='intent'||isEffectOutcome(detail.outcome)||detail.effect_mark==='disposed')&&(binding.input||phase==='boundary_refused'))await this.effect(binding,event,tx);
    return event;
  }
  private async effect(binding:JobBinding,event:Event,tx?:Transaction):Promise<void>{
    await this.records.store.withTransaction(async transaction=>{
      await this.records.store.lock(`dispatch.effect:${binding.job}`,transaction);
      const previous=(await this.records.store.findMany<EffectRecord>({kind:'effect',key:'effect.job',values:[binding.job]},transaction)).at(-1);
      const intent=eventOf(await this.events(binding.job,transaction),'intent');
      const detail=event.body.detail,values=intent?.body.detail??{};
      const definitionBytes=await this.records.objects.get(binding.executor_digest);if(!definitionBytes)throw new Error('缺少固定执行器原件；请恢复后对账');
      const d=JSON.parse(new TextDecoder().decode(definitionBytes));
      const write=d.calls.submit.write;
      const outcome=isEffectOutcome(detail.outcome)?detail.outcome:event.body.detail.phase==='intent'?'issued':previous?.body.outcome??'issued';
      const identity=values.request_identity as {subject?:unknown}|undefined;
      const body=EffectRecord.parse({schema:'effect@1',job:binding.job,run:binding.input?.run??binding.run??null,
        intent_key:values.intent_key??null,request_id:values.request_id??null,not_after:values.not_after??null,dispatch_sequence:values.dispatch_sequence??null,sequence_scope:values.sequence_scope??null,action_digest:values.action_digest??null,
        target_key:binding.target_key,covered_items:binding.input?.items??[],effect_class:write?.effect_class??'job',retry_safety:write?.retry_safety??'unsafe',signing:write?.signing??'service_on_behalf',
        content_sha256:binding.input?.sha256??null,before_state:values.before_state??{bound:false,sha256:null,reference:null},
        writing_identity:{credential:d.credential??null,on_behalf_of:binding.user,subject:identity?.subject??null},audience:null,outcome,
        marks:[...new Set([...(previous?.body.marks??[]),...(detail.effect_mark==='disposed'?['disposed']:[]),...(detail.possibly_duplicated===true?['possible_duplicate']:[])])],previous:previous?.digest??null,
        boundary:typeof detail.boundary_clause==='number'?{clause:detail.boundary_clause,code:event.body.error_code,row:detail.effect_row??null}:null,
        ...(outcome==='unknown'?{missing:detail.missing_fact??'尚未取得原请求是否执行的目标记录；需要对账',exit:{action:'request',request_kind:'disposition',audience:{user:binding.acting_by??binding.initiated_by},due:detail.deadline??previous?.body.exit?.due??new Date(Date.parse(String(values.not_after??this.now().toISOString()))+d.max_run_ms).toISOString()}}:{})});
      await this.records.store.put({kind:'effect',schema:'effect@1',provenance:'observed',created_at:this.now().toISOString(),body,index:[{key:'effect.job',value:binding.job},...(body.run?[{key:'effect.run',value:body.run}]:[])],unique_key:`effect.action:${event.digest}`},transaction);
    },tx);
  }
  async raw(binding: JobBinding, bytes: Uint8Array, operation: string, complete: boolean): Promise<{ reference: string; record: string }> {
    const source = await this.records.artifacts.ingest({ bytes, mediaType: 'application/json', origin: { read: { object: `executor:${binding.executor}:${binding.job}:${operation}` } }, author: { user: null }, provenanceType: 'observed',
      visibility: { readers: [binding.user], admins: true, packs: [], shareable: false }, readTier: 'function_bytes_only', name: complete ? 'response.json' : 'incomplete-response.json' });
    return { reference: `src:${source.body.sha256}`, record: `rec:${source.digest}` };
  }
  async binding(job: string): Promise<JobBinding> {
    const event = (await this.events(job)).find(e => e.body.detail.phase === 'reservation');
    if (!event) throw new Error('作业对你不可用');
    return event.body.detail.binding as unknown as JobBinding;
  }
}
export const newJob = () => sha256Hex(newId('job'));
export function openRequests(events:readonly Event[]):Event[] {
  const pending=new Map<string,Event>();
  for(const event of events) {
    const d=event.body.detail;
    if(d.uncertain===true && !Array.isArray(d.answers))pending.set(event.digest,event);
    if(d.unfreeze===true) {
      if(Array.isArray(d.answers)){for(const ref of d.answers)if(typeof ref==='string' && ref.startsWith('rec:'))pending.delete(ref.slice(4));}
      else for(const [key,request] of pending)if(!request.body.detail.question_sha256)pending.delete(key);
    }
  }
  return [...pending.values()];
}
export function isFrozen(events:readonly Event[]):boolean{return openRequests(events).length>0;}
/** Terminal no-send evidence frees occupancy; active reservations and unresolved effects remain exclusive. */
export function holdsPhysicalTarget(events:readonly Event[]):boolean{
 if(isFrozen(events))return true;
 const lastIntent=events.findLastIndex(event=>event.body.detail.phase==='intent'||event.body.detail.phase==='probe_intent');
 const reservation=events.find(event=>event.body.detail.phase==='reservation');
 if(reservation?.body.detail.read_only===true&&lastIntent<0)return false;
 const terminal=events.findLastIndex(event=>event.body.detail.done===true);
 if(terminal<0||lastIntent>terminal)return true;
 const end=events[terminal].body.detail;
 // A confirmed disposition releases the reservation without asserting that its old effect never happened.
 if(end.effect_mark==='disposed'&&end.disposition==='mark_failed'&&end.risk_confirmed===true&&end.unfreeze===true)return false;
 if(events.slice(terminal+1).some(event=>event.body.detail.outcome==='unknown'))return true;
 if(!isEffectOutcome(end.outcome)||end.outcome==='unknown'||end.outcome==='issued')return true;
 if(end.outcome==='not_dispatched')return !(end.submit_invoked===false||end.phase==='boundary_refused'||lastIntent<0);
 return false;
}
export const isDone = (events: readonly Event[]) => events.some(e => e.body.detail.done === true);
export const eventOf = (events: readonly Event[], phase: string) => [...events].reverse().find(e => e.body.detail.phase === phase);
export const digestOfValue = (value: unknown) => sha256Hex(canonicalBytes(value));

/** A recovered observation supplies identity without inventing a historical receipt. */
export function receiptOf(events:readonly Event[]):Event|undefined {return eventOf(events,'receipt') ?? [...events].reverse().find(e=>e.body.detail.phase==='reconciled' && e.body.detail.acceptance==='accepted' && e.body.detail.remote_id!==undefined);}
