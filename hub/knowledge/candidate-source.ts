// Source verification for model document proposals. A run supplies its boundary scope, never the client.
import { CandidateQuote } from '../../contracts/src/candidates.ts';
import type { KnowledgeCandidateBody } from '../../contracts/src/knowledge.ts';
import type { ProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { Principal } from '../records/api.ts';
import { sha256Hex } from '../records/api.ts';
import { parseReference, resolveReference, quoteMatches } from '../refs/api.ts';
import type { KnowledgeContext } from './context.ts';
import { KnowledgeError } from './errors.ts';

export type CandidateSource = NonNullable<KnowledgeCandidateBody['source']>;
export interface CandidateResolution {reference:string;text:string;provenance:ProvenanceType;record?:string}
export interface CandidateSourceScope {begin(owner:Principal):Promise<{resolve(reference:string):Promise<CandidateResolution|null>}>}
export type CandidateResolver = Awaited<ReturnType<CandidateSourceScope['begin']>>;
export async function candidateSource(context:Pick<KnowledgeContext,'records'|'parsers'>,owner:Principal,input:unknown,privateExcerpt=false,scope?:CandidateResolver):Promise<CandidateSource> {
  const parsed=CandidateQuote.safeParse(input);
  if(!parsed.success)throw new KnowledgeError('候选引用或引文形状不合格',{code:'REFERENCE_UNRESOLVED'});
  const ref=parseReference(parsed.data.reference);
  if(ref.scheme==='entry')throw new KnowledgeError('知识条目须用本次范围内的 tree 地址引用',{code:'REFERENCE_UNRESOLVED'});
  const scoped=scope===undefined?undefined:await scope.resolve(parsed.data.reference);
  if(scoped===null)throw new KnowledgeError('候选来源不在本次范围或不可读',{code:'SOURCE_UNAVAILABLE'});
  let value:CandidateResolution;
  if(ref.scheme==='src'){
    const source=await context.records.artifacts.source(owner,ref.sha256,{consumer:'model'});
    if(source===null||source.bytes===null)throw new KnowledgeError('候选的来源不可读，无法核验',{code:'SOURCE_UNAVAILABLE'});
    const body=source.artifact.body;
    if(privateExcerpt&&(!('upload' in body.origin)||body.author.user!==owner.id||body.visibility.admins||body.visibility.shareable||body.visibility.packs.length||body.visibility.readers.some(id=>id!==owner.id)))throw new KnowledgeError('会话摘录须为本人上传且只对本人可见',{code:'SOURCE_UNAVAILABLE'});
    const resolved=await resolveReference(ref,{reader:{user:owner.id,role:owner.role},parsers:context.parsers,consumer:'model',sources:{read:sha=>sha===ref.sha256?{bytes:source.bytes,mediaType:source.mediaType,size:source.size,readTier:source.readTier}:null}});
    if(!resolved.resolved||resolved.text===null)throw new KnowledgeError('候选所引片段不可解析',{code:!resolved.resolved?resolved.code:'SOURCE_UNAVAILABLE'});
    value={reference:resolved.reference,text:resolved.text,provenance:body.provenance_type,record:source.artifact.digest};
  }else{
    if(privateExcerpt||scoped===undefined)throw new KnowledgeError('该引用缺少可核验的运行范围',{code:'SOURCE_UNAVAILABLE'});
    value=scoped;
  }
  if(!quoteMatches(value.text,parsed.data.quote))throw new KnowledgeError('候选引文与来源逐字对不上',{code:'QUOTE_MISMATCH'});
  return {reference:value.reference,quote:parsed.data.quote,fragment:sha256Hex(value.text),provenance:value.provenance,...(value.record===undefined?{}:{record:value.record})};
}
