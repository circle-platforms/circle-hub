// Complete admin evidence alongside the bounded root summaries. Chunks are immutable artifacts, not a new record kind.
import {sha256Hex} from '../records/api.ts';
import type {KnowledgeContext} from './context.ts';
import {COMPONENTS} from './store.ts';
export interface ProblemChunk {record:string;sha256:string;rows:number}
export interface ProblemChunks {warnings:ProblemChunk[];refused:ProblemChunk[];skipped:ProblemChunk[]}
/** JSON escapes preserve malformed producer strings verbatim without placing them in a JSONB text field. */
export function evidenceBytes(value:unknown):Uint8Array{
 const text=JSON.stringify(value,(_key,item)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
 if(text===undefined)throw new TypeError('诊断没有可序列化的 JSON 值');return Buffer.from(text,'utf8');
}
export const emptyProblemChunks=():ProblemChunks=>({warnings:[],refused:[],skipped:[]});
export async function keepProblemRows(context:KnowledgeContext,rows:readonly unknown[],inputs:string[]):Promise<ProblemChunk[]>{
 const out:ProblemChunk[]=[];
 for(let at=0;at<rows.length;at+=100){
  const part=rows.slice(at,at+100);
  const artifact=await context.records.artifacts.ingest({bytes:evidenceBytes(part),mediaType:'application/json',origin:{generated:{generator:COMPONENTS.produce,inputs}},author:{user:null},provenanceType:'projected',visibility:{readers:[],admins:true,packs:[],shareable:false},name:'knowledge-problems.json'});
  out.push({record:artifact.digest,sha256:artifact.body.sha256,rows:part.length});
 }
 return out;
}
/** Trusted Hub-written retry metadata; these bytes never go directly to a model. */
export async function readProblemRows(context:KnowledgeContext,refs:readonly ProblemChunk[]):Promise<any[]>{
 const out:any[]=[];
 for(const ref of refs){
  const record=await context.records.store.get<{sha256:string;author:{user:string|null}}>(ref.record);
  const bytes=await context.records.objects.get(ref.sha256);
  if(record?.kind!=='source_artifact'||record.body.sha256!==ref.sha256||record.body.author.user!==null||bytes===null||sha256Hex(bytes)!==ref.sha256)throw new Error('知识同步问题分块缺失或摘要不符；恢复此分块后重新同步');
  const rows=JSON.parse(Buffer.from(bytes).toString('utf8'));if(!Array.isArray(rows)||rows.length!==ref.rows)throw new Error('知识同步问题分块行数不符；恢复此分块后重新同步');out.push(...rows);
 }
 return out;
}
