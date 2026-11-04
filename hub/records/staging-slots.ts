// Queued extraction/checks hold no database connection. Skip occupied owners so one member cannot block another.
import {AsyncLocalStorage} from 'node:async_hooks';
import {LimitError} from './errors.ts';
export const MAX_STAGING_WAITING=8;
export const MAX_MEMBER_STAGING_WAITING=2;
export function stagingSlots(limit:number){
 const owners=new Set<string>(),waiting:{owner:string;run:()=>Promise<void>}[]=[];
 const pump=()=>{
  while(owners.size<limit){
   const next=waiting.findIndex(item=>!owners.has(item.owner));if(next<0)return;
   const item=waiting.splice(next,1)[0];owners.add(item.owner);
   void item.run().finally(()=>{owners.delete(item.owner);pump();});
  }
 };
 return <T>(owner:string,work:()=>Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  // A runnable caller consumes an execution slot, not a waiting slot.
  if((owners.has(owner)||owners.size>=limit)&&(waiting.length>=MAX_STAGING_WAITING||waiting.filter(item=>item.owner===owner).length>=MAX_MEMBER_STAGING_WAITING)){
   reject(new LimitError('发布校验繁忙，请稍后重试'));return;
  }
  // A later call's pump starts this work: it keeps the context (request scope, trace) of the call that asked for it.
  const resume=AsyncLocalStorage.snapshot();
  waiting.push({owner,run:()=>resume(async()=>{try{resolve(await work());}catch(error){reject(error);}})});pump();
 });
}
