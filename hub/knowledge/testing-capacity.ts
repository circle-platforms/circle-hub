// Synthetic legacy data mirrors the former free-first-root-source bug; it never rewrites an existing record.
import {canonicalize,type RecordsKit,type Principal} from '../records/api.ts';
export async function legacyRootSource(records:Pick<RecordsKit,'artifacts'|'store'|'objects'>,owner:Principal,counter=0){
 const bytes=Buffer.from('合成原文。'.repeat(6000)),at='2026-11-03T00:00:00.000Z';
 const file=await records.artifacts.ingest({bytes,mediaType:'text/plain',name:'合成旧计量原文.txt',origin:{upload:{session:null,message:null}},author:{user:owner.id},provenanceType:'declared',visibility:{readers:[owner.id],admins:false,packs:[],shareable:false}});
 const source=await records.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space:owner.id,path:'/',sha256:file.body.sha256,artifact:file.digest,size:bytes.length,by:owner.id,at},index:[{key:'knowledge.space.source',value:owner.id},{key:'knowledge.space.source_hash',value:file.body.sha256}]});
 const tree=await records.objects.put(Buffer.from(canonicalize({name:'',children:[],entries:[]})),'application/json',undefined,owner.id);
 const body={space:owner.id,parent:null,tree:tree.sha256,sources:[source.digest],products:[],directories:['/'],entries:[],by:owner.id,at,reason:'导入原文',used_bytes:counter};
 const record=await records.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body,index:[{key:'knowledge.space.version',value:owner.id}]});
 return {record:await records.store.get(record.digest),file,source,bytes,expected:bytes.length+Buffer.byteLength(canonicalize(body))};
}
