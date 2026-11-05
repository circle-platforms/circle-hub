import { parseReference } from '../refs/api.ts';
import type { UnknownExit } from '../../contracts/src/validation.ts';
// Read-only journal projection for the run engine. The dispatch service rechecks the actual administrator per job.
import { z } from 'zod';
import { RunId, Sha256, UserId, IsoTime } from '../../contracts/src/common.ts';
import { IntegrityError, type ActionBody, type Page, type Principal, type RecordsKit, type StoredRecord } from '../records/api.ts';
import type { DispatchService, JobStatus } from './service.ts';
const Input=z.object({run:RunId,plan_run:RunId,item:z.string().min(1),items:z.array(z.string().min(1)),sha256:Sha256});
export interface RunJob {
  /** Administrative proof reference; keep it behind an administrator-only read tier, never return raw journal bodies. */
  job:string;record?:string;management_exit?:UnknownExit;verification_run:string;plan_run:string;verification_item:string;items:string[];sha256:string;status:JobStatus;
  /** From the journal, never from the name of the last phase (cleanup such as the target lease release may follow the end):
   * 'done' once the job has its terminal record, 'unknown' once its effect is recorded as unresolved and waits for an
   * administrator, null while it runs. */
  ended:'done'|'unknown'|null;
  /** Whether the job ended at the effect boundary before any remote call: its journal records the refusal and no response
   * of the target. A refusal at the final boundary, after the connector session, the precheck and the probes, is not one. */
  boundary_refused:boolean;
  /** The executor (runtime environment) the reservation bound; absent when it names none. */
  executor?:string;
}
const remoteResponse=(phase:unknown)=>typeof phase==='string'&&phase.endsWith('.response');
/**
 * The runs these jobs are bound to (as verification run or plan run), each with its jobs among them, from those jobs' journals
 * alone. Job events are indexed by job, not by run: run maintenance asks this about the jobs something just happened to.
 */
export async function dispatchedRuns(records:Pick<RecordsKit,'store'>,jobs:readonly string[]):Promise<Map<string,string[]>>{
  const runs=new Map<string,string[]>();
  for(let at=0;at<jobs.length;at+=128)for(const record of await records.store.findMany<ActionBody>({kind:'action',key:'dispatch.job',values:jobs.slice(at,at+128)})){
    if(record.body.detail.phase!=='reservation')continue;
    const binding=record.body.detail.binding as {job?:unknown;input?:{run?:unknown;plan_run?:unknown}}|undefined;
    if(typeof binding?.job!=='string')continue;
    for(const run of [binding.input?.run,binding.input?.plan_run])if(typeof run==='string'){const bound=runs.get(run)??[];if(!bound.includes(binding.job))bound.push(binding.job);runs.set(run,bound);}
  }
  return runs;
}
/** A reservation's binding as written. It is checked when a run's jobs are read, so a bad record spoils its own run only. */
interface ReservationBinding {job?:unknown;run?:unknown;executor?:unknown;input?:{run?:unknown;plan_run?:unknown}|null}
export type RunReservations=ReadonlyMap<string,readonly ReservationBinding[]>;
/**
 * Every reservation by the runs it names. Reservations are indexed by phase, not by run, so one run's jobs cost a reading of
 * them all: a pass over many runs reads this once and hands it to readRunJobs. They are only appended, so an older reading
 * misses at most the newest, which the next pass sees.
 */
export async function runReservations(records:Pick<RecordsKit,'store'>):Promise<RunReservations>{
  const runs=new Map<string,ReservationBinding[]>();let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<ActionBody>>=await records.store.find<ActionBody>({kind:'action',key:'dispatch.phase',value:'reservation',limit:500,cursor});
    for(const record of page.items){
      const binding=record.body.detail.binding as ReservationBinding|undefined;
      if(!binding)continue;
      for(const run of new Set(binding.input?[binding.input.run,binding.input.plan_run]:[binding.run]))if(typeof run==='string'){const named=runs.get(run);if(named)named.push(binding);else runs.set(run,[binding]);}
    }
    cursor=page.next;
  }while(cursor!==null);
  return runs;
}
/**
 * The jobs bound to a run. With `unbound`, also the run's jobs refused by the preflight before any input was bound (their
 * binding names the run only): the runner's notes list them, run maintenance does not need them. Such a job carries the
 * run as its verification run and no plan run, item or digest. `reservations` saves the reading of runReservations.
 */
export async function readRunJobs(records:Pick<RecordsKit,'store'>,dispatch:Pick<DispatchService,'status'>,by:Principal,run:string,options:{unbound?:boolean;reservations?:RunReservations}={}):Promise<RunJob[]>{
  RunId.parse(run);
  const jobs=new Map<string,z.infer<typeof Input>|null>();const executors=new Map<string,string>();
  for(const binding of (options.reservations??await runReservations(records)).get(run)??[]){
    if(!binding.input){if(options.unbound){const job=Sha256.safeParse(binding.job);if(job.success&&!jobs.has(job.data))jobs.set(job.data,null);}continue;}
    const input=Input.safeParse(binding.input),job=Sha256.safeParse(binding.job);
    if(!input.success||!job.success)throw new IntegrityError('派发预订记录缺少运行绑定');
    const old=jobs.get(job.data);
    if(old&&JSON.stringify(old)!==JSON.stringify(input.data))throw new IntegrityError('同一作业有不同运行绑定');
    jobs.set(job.data,input.data);
    if(typeof binding.executor==='string'&&/^exe_[0-9a-hjkmnp-tv-z]{26}$/.test(binding.executor))executors.set(job.data,binding.executor);
  }
  const out:RunJob[]=[];
  for(const [job,input] of jobs){
    const {admin_release:_privateRelease,admin_release_missing:_privateMissing,...status}=await dispatch.status(by,job);
    const history=await records.store.findMany<ActionBody>({kind:'action',key:'dispatch.job',values:[job]});
    const prefix=history.slice(0,status.events);
    const choice=[...prefix].reverse().find(e=>e.body.detail.phase==='dispose'&&e.body.detail.disposition===status.disposition);
    if(choice&&status.disposition){if(!status.decided_by&&UserId.safeParse(choice.body.detail.acting_by).success)status.decided_by=String(choice.body.detail.acting_by);if(!status.decided_at&&IsoTime.safeParse(choice.body.ended_at).success)status.decided_at=choice.body.ended_at;}
    let management_exit:UnknownExit|undefined;
    if(choice&&Array.isArray(choice.body.detail.answers))for(const value of choice.body.detail.answers){
      if(typeof value!=='string')continue;
      let ref;try{ref=parseReference(value);}catch{continue;}
      const question=ref.scheme==='rec'?prefix.find(r=>r.digest===ref.record):undefined;
      if(question&&UserId.safeParse(question.body.detail.audience_user).success&&IsoTime.safeParse(question.body.detail.deadline).success){management_exit={action:'request',request_kind:'disposition',audience:{user:String(question.body.detail.audience_user)},due:String(question.body.detail.deadline)};break;}
    }
    const proof=history[status.events-1];
    if(!proof)throw new IntegrityError('派发状态缺少对应的追加记录前缀');
    const ended=prefix.some(e=>e.body.detail.done===true)?'done':prefix.some(e=>e.body.detail.phase==='unknown')?'unknown':null;
    const refusal=prefix.findIndex(e=>e.body.detail.phase==='boundary_refused');
    const boundary_refused=refusal>=0&&!prefix.slice(0,refusal).some(e=>remoteResponse(e.body.detail.phase));
    const bound=input?{verification_run:input.run,plan_run:input.plan_run,verification_item:input.item,items:[...input.items],sha256:input.sha256}:{verification_run:run,plan_run:'',verification_item:'',items:[],sha256:''};
    out.push({job,record:proof.digest,...bound,status,ended,boundary_refused,...(executors.has(job)?{executor:executors.get(job)!}:{}),...(management_exit?{management_exit}:{})});
  }
  return out;
}
