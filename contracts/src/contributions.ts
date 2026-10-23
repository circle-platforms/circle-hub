// K03/P10 document contributions are ordinary workflow artifacts, not Hub-local candidates.
import { z } from 'zod';
import { DocumentOutputKindSchema, TaskOutputKindSchema, RelationKindSchema, ProvenanceTypeSchema, BasisRankSchema, KnowledgeLayerSchema, ValidityStatusSchema } from '../generated/vocabulary.ts';
import { Sha256, UserId, IsoTime } from './common.ts';
import { ReferenceUri, TreePath } from './reference.ts';
import { Applicability, ProductId } from './product.ts';

export const OutputKey=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const TaskOutput=z.strictObject({id:OutputKey,kind:TaskOutputKindSchema});
export const WorkflowOutputs=z.strictObject({tasks:z.array(TaskOutput).max(32)}).superRefine((v,ctx)=>{
  const ids=new Set<string>();v.tasks.forEach((row,i)=>{if(ids.has(row.id))ctx.addIssue({code:'custom',path:['tasks',i,'id'],message:'task output ids are unique'});ids.add(row.id);});
});
export const TaskOutputValue=z.strictObject({output:OutputKey,value:z.unknown()});
export const ContributionQuote=z.strictObject({reference:ReferenceUri,quote:z.string().min(1).max(65536)});
// Input relation: both endpoints are verified before it can become a stored relation record.
export const ContributionRelation=z.strictObject({kind:RelationKindSchema,other:ContributionQuote});
export const ContributionInput=z.strictObject({
  kind:DocumentOutputKindSchema,statement:z.string().min(1).max(65536),
  root:Sha256,path:TreePath,source:ContributionQuote,relation:ContributionRelation.optional(),
}).superRefine((v,ctx)=>{if((v.kind==='relation')!==(v.relation!==undefined))ctx.addIssue({code:'custom',path:['relation'],message:'only a relation output has a relation endpoint'});});
export type ContributionInput=z.infer<typeof ContributionInput>;
export const ContributionSource=ContributionQuote.extend({
  fragment:Sha256,provenance:ProvenanceTypeSchema.extract(['observed','projected']),records:z.array(Sha256).min(1),sources:z.array(Sha256).min(1),
});
// Central STORED relation shape for K3; this never mutates either endpoint.
export const ContributionRelationRecord=z.strictObject({kind:RelationKindSchema,other:ContributionSource});
export const KNOWLEDGE_CONTRIBUTION_SCHEMA='knowledge-contribution@1';
/** Unsupported revisions fail closed in readers rather than falling through to administrator access. */
export const isKnowledgeContributionSchema=(schema:string):boolean=>schema.startsWith(KNOWLEDGE_CONTRIBUTION_SCHEMA.split('@')[0]+'@');
export const KnowledgeContributionBody=z.strictObject({
  layer:KnowledgeLayerSchema.extract(['contribution']),product:ProductId,root:Sha256,path:TreePath,
  cited_fragment:Sha256,kind:DocumentOutputKindSchema,statement:z.string().min(1),source:ContributionSource,
  relation:ContributionRelationRecord.optional(),
  submitted_by:UserId,session:z.string().nullable(),submitted_at:IsoTime,
  model:z.string().describe('client-declared integration model/configuration, not an evidence grade'),
  basis_rank:BasisRankSchema,applicability:Applicability.nullable(),
});
export type KnowledgeContributionBody=z.infer<typeof KnowledgeContributionBody>;
export const WithheldContributionSource=ContributionSource.omit({quote:true});
export const WithheldContributionBody=KnowledgeContributionBody.omit({statement:true,source:true,relation:true}).extend({
  source:WithheldContributionSource,relation:ContributionRelationRecord.omit({other:true}).extend({other:WithheldContributionSource}).optional(),
});
export const KnowledgeContributionView=z.union([
  z.strictObject({record:Sha256,contribution:KnowledgeContributionBody,status:ValidityStatusSchema.extract(['valid','cited_fragment_changed']),note:z.string().nullable()}),
  z.strictObject({record:Sha256,contribution:WithheldContributionBody,status:ValidityStatusSchema.extract(['credential_unreadable']),note:z.string()}),
]);
export type KnowledgeContributionView=z.infer<typeof KnowledgeContributionView>;
