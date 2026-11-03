// Preserve an exact, already published team declaration without retaining its private source path or text.
import {SourceAttributionBody,SpaceSourceBody,TeamSourceAttributionBody} from '../../contracts/src/spaces.ts';
import type {RecordStore,ObjectStore,Principal,SourceArtifactBody,Transaction,Page,StoredRecord} from './api.ts';
import {canonicalize} from './canonical.ts';
import {sha256Hex} from './digest.ts';
export const TEAM_ATTRIBUTION_KEY='knowledge.team.attribution.source';
export async function preserveTeamAttributions(store:RecordStore,objects:ObjectStore,owner:string,by:Principal,tx:Transaction,now:()=>Date){
 let cursor:string|null=null;
 do{
  const page:Page<StoredRecord>=await store.list({kind:'knowledge_space_source',limit:100,cursor},tx);cursor=page.next;
  for(const team of page.items){
   const target=SpaceSourceBody.safeParse(team.body);if(!target.success||target.data.space!=='team'||!target.data.attribution)continue;
   const row=target.data,existing=await store.findMany({kind:'knowledge_team_source_attribution',key:TEAM_ATTRIBUTION_KEY,values:[team.digest]},tx);
   if(existing.some(record=>{const receipt=TeamSourceAttributionBody.safeParse(record.body);return receipt.success&&receipt.data.team_source===team.digest&&receipt.data.declaration===row.attribution&&receipt.data.artifact===row.artifact&&receipt.data.sha256===row.sha256;}))continue;
   const declaration=await store.get(row.attribution!,tx);if(declaration?.kind!=='knowledge_source_attribution'||declaration.schema!=='knowledge-source-attribution@1'||declaration.provenance!=='declared')continue;
   const parsed=SourceAttributionBody.safeParse(declaration.body);if(!parsed.success||parsed.data.by!==owner||parsed.data.space!==owner)continue;
   const signed=parsed.data,registration=await store.get(signed.source,tx),source=registration?.kind==='knowledge_space_source'?SpaceSourceBody.safeParse(registration.body):null;
   const original=await store.get<SourceArtifactBody>(signed.artifact,tx),copy=await store.get<SourceArtifactBody>(row.artifact,tx);
   if(!source?.success||source.data.space!==owner||source.data.by!==owner||source.data.artifact!==signed.artifact||source.data.sha256!==signed.sha256||signed.sha256!==row.sha256)continue;
   if(original?.kind!=='source_artifact'||original.provenance!=='declared'||original.schema!=='source_artifact@1'||original.body.author.user!==owner||original.body.sha256!==signed.sha256||original.body.provenance_type!=='declared'||!('upload'in original.body.origin))continue;
   if(copy?.kind!=='source_artifact'||copy.provenance!=='declared'||copy.schema!=='source_artifact@1'||copy.body.author.user!==owner||copy.body.sha256!==signed.sha256||copy.body.provenance_type!=='declared'||!('upload'in copy.body.origin)||!copy.body.visibility.admins||canonicalize(copy.body.origin)!==canonicalize(original.body.origin))continue;
   const bytes=await objects.get(copy.body.sha256);if(!bytes||bytes.length!==copy.body.size||bytes.length!==original.body.size||sha256Hex(bytes)!==signed.sha256)continue;
   const body=TeamSourceAttributionBody.parse({team_source:team.digest,declaration:declaration.digest,uploader:owner,declared_at:signed.at,artifact:row.artifact,sha256:row.sha256,by:by.id,at:now().toISOString()});
   await store.put({kind:'knowledge_team_source_attribution',schema:'knowledge-team-source-attribution@1',provenance:'declared',body,unique_key:team.digest,index:[{key:TEAM_ATTRIBUTION_KEY,value:team.digest}]},tx);
  }
 }while(cursor);
}
