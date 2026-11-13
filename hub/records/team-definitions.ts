import { z } from 'zod';
import { TeamId } from '../../contracts/api.ts';
import type { AuthorizationRecord, ObjectStore, RecordStore, Transaction, Page } from './api.ts';
import { sha256Hex } from './digest.ts';
import { parseStrictJson } from './strict-json.ts';
import { IntegrityError } from './errors.ts';
export interface Team { id: string; name: string; created_at: string; created_by: string; deleted_at: string | null }
const TeamDefinition=z.strictObject({id:TeamId,name:z.string().regex(/^[^\s\p{Cc}](?:[^\p{Cc}]{0,98}[^\s\p{Cc}])?$/u)});
export async function readTeamDefinitions(store:RecordStore,objects:ObjectStore,now:()=>Date,tx?:Transaction):Promise<Team[]>{
  const latest=new Map<string,AuthorizationRecord>();let cursor:string|null=null;
  do{const page:Page<AuthorizationRecord>=await store.find<AuthorizationRecord['body']>({kind:'authorization',key:'authz.subject',value:'assign|*',limit:500,cursor},tx);for(const row of page.items)latest.set(row.body.object,row);cursor=page.next;}while(cursor!==null);
  const teams:Team[]=[];
  for(const decision of latest.values()){
    if(!TeamId.safeParse(decision.body.object).success||decision.body.revoked||decision.body.expires_at!==null&&Date.parse(decision.body.expires_at)<=now().getTime())continue;
    const bound=decision.body.bound,bytes=bound===null?null:await objects.get(bound,tx);
    if(bytes===null||sha256Hex(bytes)!==bound)throw new IntegrityError('团队定义原件缺失或摘要不符');
    const checked=TeamDefinition.safeParse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
    if(!checked.success||checked.data.id!==decision.body.object)throw new IntegrityError('团队定义与登记不一致');
    teams.push({id:decision.body.object,name:checked.data.name,created_at:decision.body.decided_at,created_by:decision.body.decided_by,deleted_at:null});
  }
  return teams.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
}
