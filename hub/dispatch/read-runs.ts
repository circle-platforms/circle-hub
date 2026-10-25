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
}
export async function readRunJobs(records:Pick<RecordsKit,'store'>,dispatch:Pick<DispatchService,'status'>,by:Principal,run:string):Promise<RunJob[]>{
  RunId.parse(run);
  const jobs=new Map<string,z.infer<typeof Input>>();let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<ActionBody>>=await records.store.find<ActionBody>({kind:'action',key:'dispatch.phase',value:'reservation',limit:500,cursor});
    for(const record of page.items){
      const binding=record.body.detail.binding as {job?:unknown;input?:{run?:unknown;plan_run?:unknown}}|undefined;
      if(!binding?.input||binding.input.run!==run&&binding.input.plan_run!==run)continue;
      const input=Input.safeParse(binding.input),job=Sha256.safeParse(binding.job);
      if(!input.success||!job.success)throw new IntegrityError('派发预订记录缺少运行绑定');
      const old=jobs.get(job.data);
      if(old&&JSON.stringify(old)!==JSON.stringify(input.data))throw new IntegrityError('同一作业有不同运行绑定');
      jobs.set(job.data,input.data);
    }
    cursor=page.next;
  }while(cursor!==null);
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
    out.push({job,record:proof.digest,verification_run:input.run,plan_run:input.plan_run,verification_item:input.item,items:[...input.items],sha256:input.sha256,status,...(management_exit?{management_exit}:{})});
  }
  return out;
}
