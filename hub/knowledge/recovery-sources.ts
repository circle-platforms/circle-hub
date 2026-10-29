import type { KnowledgePort } from '../ports.ts';
import { sha256Hex, type Principal } from '../records/api.ts';
import type { Knowledge } from './service.ts';

const MAX_SOURCES=512, BATCH=8;
/** A root reader may see derived entries without direct access to the synchronizer's raw captures. */
export async function recoverySourcesReadable(knowledge:KnowledgePort,user:Principal,root:string):Promise<boolean>{
  const context=(knowledge as Partial<Knowledge>).__context,reader=knowledge.treeReader();
  if(!context?.admin||!knowledge.rootSources||!reader.hasRoot||!await reader.hasRoot(root,{user:user.id,role:user.role}))return false;
  const sources=await knowledge.rootSources(root);
  if(!sources.length||sources.length>MAX_SOURCES)return false;
  const unique=[...new Map(sources.map(source=>[`${source.sha256}\0${source.artifact}`,source])).values()];
  for(let at=0;at<unique.length;at+=BATCH){
    const results=await Promise.all(unique.slice(at,at+BATCH).map(async source=>{
      const current=await context.records.artifacts.source(context.admin!,source.sha256,{consumer:'model',record:source.artifact});
      const scan=current?.artifact.body.scan;
      return !!current&&current.readTier==='model_readable'&&!!current.bytes&&current.bytes.length===current.size&&sha256Hex(current.bytes)===source.sha256&&current.acceptance===undefined&&scan?.inspected===true&&!scan.truncated&&scan.findings.length===0;
    }));
    if(results.some(ok=>!ok))return false;
  }
  return true;
}
