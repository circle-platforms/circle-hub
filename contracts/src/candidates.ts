// W07 R[4], K03: wire-only document outputs are separated from ordinary task outputs.
// These are owner-specified output-format tags, not a new vocabulary axis or an evidence grade.
import { z } from 'zod';
import { DocumentOutputKindSchema, TaskOutputKindSchema, RelationKindSchema } from '../generated/vocabulary.ts';
import { Sha256 } from './common.ts';
import { TreePath, ReferenceUri } from './reference.ts';

export const OutputKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const CandidateQuote = z.strictObject({reference:ReferenceUri,quote:z.string().min(1).max(65536)});
export const CandidateBinding = z.strictObject({root:Sha256,path:TreePath});
export const DocumentOutput = z.strictObject({
  id:OutputKey,
  input:OutputKey.optional().describe('the workflow input slot whose document fragments this output may reference'),
  kind:DocumentOutputKindSchema,
  max_items:z.number().int().positive().max(100).default(100),
});
export const TaskOutput = z.strictObject({id:OutputKey,kind:TaskOutputKindSchema});
export const WorkflowOutputs = z.strictObject({
  documents:z.array(DocumentOutput).max(32).default([]),
  tasks:z.array(TaskOutput).max(32).default([]),
}).superRefine((value,ctx)=>{
  const names=new Set<string>();
  for(const [group,rows] of Object.entries(value))for(const [i,row]of rows.entries()){
    if(names.has(row.id))ctx.addIssue({code:'custom',path:[group,i,'id'],message:'output ids are unique across both destinations'});
    names.add(row.id);
  }
});
export type WorkflowOutputs = z.infer<typeof WorkflowOutputs>;
export const CandidateProposal = z.strictObject({
  output:OutputKey,
  statement:z.string().min(1).max(65536),
  source:CandidateQuote,
  binding:CandidateBinding.optional(),
  ground:CandidateQuote.optional().describe('private session excerpt when the proposal is grounded in a conversation'),
  relation:z.strictObject({name:RelationKindSchema,other:CandidateQuote}).optional(),
});
export type CandidateProposal = z.infer<typeof CandidateProposal>;
export const CandidateSummary = z.strictObject({count:z.number().int().nonnegative(),sha256:Sha256});
export type CandidateSummary = z.infer<typeof CandidateSummary>;
export const TaskOutputValue = z.strictObject({output:OutputKey,value:z.unknown()});
