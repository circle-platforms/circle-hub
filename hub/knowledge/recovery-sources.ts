import type { KnowledgePort } from '../ports.ts';
import { sha256Hex, type Principal } from '../records/api.ts';
import type { Knowledge } from './service.ts';

const MAX_SOURCES=512, BATCH=8;
/**
 * A root reader may see derived entries without direct access to the synchronizer's raw captures. Every source of the root must
 * still be model-readable as the live read decides it: clean, or carrying credential findings that an acceptance in force lifts
 * (a manual with example passwords accepted by an administrator is readable; one that nothing lifts is retained only).
 */
export async function recoverySourcesReadable(knowledge:KnowledgePort,user:Principal,root:string):Promise<boolean>{
  const context=(knowledge as Partial<Knowledge>).__context,reader=knowledge.treeReader();
  if(!context||!knowledge.rootSources||!reader.hasRoot||!await reader.hasRoot(root,{user:user.id,role:user.role}))return false;
  // The raw captures are read as an administrator. A deployed Hub has no standing admin in the knowledge context (every sync
  // names its own), so the recheck takes an enabled administrator account as stored now; none enabled means it cannot be checked.
  const admin=context.admin??await enabledAdmin(context.records.principals);
  if(!admin)return false;
  const sources=await knowledge.rootSources(root);
  if(!sources.length||sources.length>MAX_SOURCES)return false;
  const unique=[...new Map(sources.map(source=>[`${source.sha256}\0${source.artifact}`,source])).values()];
  for(let at=0;at<unique.length;at+=BATCH){
    const results=await Promise.all(unique.slice(at,at+BATCH).map(async source=>{
      const current=await context.records.artifacts.source(admin,source.sha256,{consumer:'model',record:source.artifact});
      const scan=current?.artifact.body.scan;
      return !!current&&current.readTier==='model_readable'&&!!current.bytes&&current.bytes.length===current.size&&sha256Hex(current.bytes)===source.sha256&&(current.acceptance!==undefined||scan?.inspected===true&&!scan.truncated&&scan.findings.length===0);
    }));
    if(results.some(ok=>!ok))return false;
  }
  return true;
}

async function enabledAdmin(principals:{list?:()=>Promise<Array<{id:string;name:string;role:string;disabled:boolean}>>}):Promise<Principal|null>{
  const users=await principals.list?.();
  const admin=users?.find(user=>user.role==='admin'&&!user.disabled);
  return admin?{id:admin.id,name:admin.name,role:'admin'}:null;
}
