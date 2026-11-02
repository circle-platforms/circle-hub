// Current personal-pack grants are shared by publication and result readers; they confer no administrator bypass.
import { PersonalPackGrantBody } from '../../contracts/src/sharing.ts';
import type { Principal, RecordStore, Page, StoredRecord } from './api.ts';

export const personalPackKey=(space:string,pack:string)=>space+'/'+pack;
export async function personalPackGrants(store:RecordStore,space:string,pack:string):Promise<PersonalPackGrantBody[]> {
  let cursor:string|null=null;const latest=new Map<string,PersonalPackGrantBody>();
  do{
    const page:Page<StoredRecord<unknown>>=await store.find({kind:'personal_pack_grant',key:'personal.pack.grant',value:personalPackKey(space,pack),limit:500,cursor});
    for(const record of page.items){const body=PersonalPackGrantBody.parse(record.body);if(body.space!==space||body.pack!==pack||body.by!==space)continue;latest.set(body.audience+'/'+(body.member??''),body);}
    cursor=page.next;
  }while(cursor);
  return [...latest.values()].filter(grant=>grant.action==='grant');
}
export async function mayUsePersonalPack(store:RecordStore,by:Principal,space:string,pack:string):Promise<boolean>{
  if(by.id===space)return true;
  return (await personalPackGrants(store,space,pack)).some(grant=>grant.audience==='member'?grant.member===by.id:by.role==='admin');
}
