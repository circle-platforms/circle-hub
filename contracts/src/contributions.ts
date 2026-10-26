import {KnowledgeStructureSchema} from './feeding.ts';
import {QuoteEvidenceSchema} from '../generated/shared-interfaces.ts';
import {ApplicabilityFieldSchema,DeclarationStatusSchema,JudgmentStatusSchema} from '../generated/vocabulary.ts';
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
export const ApplicabilityClaimInput=z.strictObject({entry:Sha256,field:ApplicabilityFieldSchema,value:z.unknown().refine(v=>v!==undefined,'declare a value'),section:z.array(z.string()),evidence:QuoteEvidenceSchema});
export const AdmittedApplicabilityClaim=ApplicabilityClaimInput.extend({admission:z.strictObject({composition:Sha256,criteria_digest:Sha256,declarations:z.array(Sha256)})});
export const ApplicabilityFieldView=z.strictObject({declaration_status:DeclarationStatusSchema.nullable(),judgment_status:JudgmentStatusSchema.nullable(),declaration_value:z.unknown(),judgments:z.array(Sha256),legacy_value:z.unknown().optional(),conflicted:z.boolean(),missing:z.string().optional(),next_action:z.string().optional()});
export const ApplicabilityFields=z.record(ApplicabilityFieldSchema,ApplicabilityFieldView);
export type ApplicabilityFields=z.infer<typeof ApplicabilityFields>;
export const ContributionInput=z.strictObject({
  kind:DocumentOutputKindSchema,statement:z.string().min(1).max(65536),
  root:Sha256,path:TreePath,source:ContributionQuote,relation:ContributionRelation.optional(),
  applicability_claim:ApplicabilityClaimInput.optional(),feeding:KnowledgeStructureSchema.optional(),
}).superRefine((v,ctx)=>{if((v.kind==='applicability_claim')!==(v.applicability_claim!==undefined))ctx.addIssue({code:'custom',path:['applicability_claim'],message:'only applicability_claim carries a typed field claim'});if((v.kind==='relation')!==(v.relation!==undefined))ctx.addIssue({code:'custom',path:['relation'],message:'only a relation output has a relation endpoint'});});
export type ContributionInput=z.infer<typeof ContributionInput>;
export const ContributionSource=ContributionQuote.extend({
  fragment:Sha256,provenance:ProvenanceTypeSchema.extract(['observed','projected','client_captured']),records:z.array(Sha256).min(1),sources:z.array(Sha256).min(1),
});
const FeedingContributionSource=ContributionSource.extend({provenance:ProvenanceTypeSchema.extract(['observed','projected','declared','client_captured'])});
// Central STORED relation shape for K3; this never mutates either endpoint.
export const ContributionRelationRecord=z.strictObject({kind:RelationKindSchema,other:ContributionSource});
export const KNOWLEDGE_CONTRIBUTION_SCHEMA='knowledge-contribution@1';
/** Unsupported revisions fail closed in readers rather than falling through to administrator access. */
export const isKnowledgeContributionSchema=(schema:string):boolean=>schema.startsWith(KNOWLEDGE_CONTRIBUTION_SCHEMA.split('@')[0]+'@');
export const KnowledgeContributionBody=z.strictObject({
  layer:KnowledgeLayerSchema.extract(['contribution']),product:ProductId,root:Sha256,path:TreePath,
  cited_fragment:Sha256,kind:DocumentOutputKindSchema,statement:z.string().min(1),source:FeedingContributionSource,
  relation:ContributionRelationRecord.optional(),
  applicability_claim:AdmittedApplicabilityClaim.optional(),feeding:KnowledgeStructureSchema.optional(),feeding_record:Sha256.optional(),
  submitted_by:UserId,session:z.string().nullable(),submitted_at:IsoTime,
  model:z.string().describe('client-declared integration model/configuration, not an evidence grade'),
  basis_rank:BasisRankSchema,applicability:Applicability.nullable(),
});
export type KnowledgeContributionBody=z.infer<typeof KnowledgeContributionBody>;
export const WithheldContributionSource=FeedingContributionSource.omit({quote:true});
export const WithheldContributionBody=KnowledgeContributionBody.omit({statement:true,source:true,relation:true,applicability_claim:true,feeding:true,feeding_record:true}).extend({
  source:WithheldContributionSource,relation:ContributionRelationRecord.omit({other:true}).extend({other:WithheldContributionSource}).optional(),
});
export const KnowledgeContributionView=z.union([
  z.strictObject({record:Sha256,contribution:KnowledgeContributionBody,status:ValidityStatusSchema.extract(['valid','cited_fragment_changed','grounds_withdrawn']),note:z.string().nullable()}),
  z.strictObject({record:Sha256,contribution:WithheldContributionBody,status:ValidityStatusSchema.extract(['credential_unreadable']),note:z.string()}),
]);
export type KnowledgeContributionView=z.infer<typeof KnowledgeContributionView>;
export const MAX_NODE_CONTRIBUTIONS=100;
/** A bounded node page can defer a large body to its separately paginated immutable record. */
export const KnowledgeContributionPageView=z.union([KnowledgeContributionView,z.strictObject({
  record:Sha256,contribution:z.never().optional(),status:ValidityStatusSchema.extract(['valid','cited_fragment_changed','credential_unreadable','grounds_withdrawn']),note:z.string(),
})]);
export type KnowledgeContributionPageView=z.infer<typeof KnowledgeContributionPageView>;
