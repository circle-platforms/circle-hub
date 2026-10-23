import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandidateProposal, WorkflowOutputs } from './candidates.ts';
import { Submission, RecordedSubmission } from './submission.ts';

const source={reference:`src:${'a'.repeat(64)}`,quote:'synthetic quotation'};
const candidate={output:'document_claim',statement:'a synthetic private statement',source};
const base={run:`run_0${'a'.repeat(25)}`,model:'scripted',items:[]};
test('document outputs declare four formats and task outputs have a separate destination',()=>{
  assert.ok(WorkflowOutputs.safeParse({documents:['classification','placement_proposal','assertion','relation'].map((kind,i)=>({id:`d${i}`,input:'documents',kind})),tasks:['ranking','selection','score'].map((kind,i)=>({id:`t${i}`,kind}))}).success);
  assert.ok(!WorkflowOutputs.safeParse({documents:[{id:'d',input:'documents',kind:'score'}]}).success);
  assert.ok(!WorkflowOutputs.safeParse({documents:[{id:'same',input:'documents',kind:'assertion'}],tasks:[{id:'same',kind:'score'}]}).success);
});
test('wire candidate shapes never accept a model-supplied evidence grade or applicability',()=>{
  assert.ok(CandidateProposal.safeParse(candidate).success);
  for(const field of ['provenance','source_provenance','basis_rank','confidence','applicability','score'])assert.ok(!CandidateProposal.safeParse({...candidate,[field]:field==='applicability'?{platforms:['invented']}:1}).success,field);
});
test('wire submissions may carry candidates; the stored submission permits only count and digest',()=>{
  assert.ok(Submission.safeParse({...base,candidates:[candidate]}).success);
  assert.ok(!RecordedSubmission.safeParse({...base,candidates:[candidate]}).success);
  const summary={count:1,sha256:'b'.repeat(64)};
  assert.ok(RecordedSubmission.safeParse({...base,candidate_summary:summary}).success);
  assert.ok(!Submission.safeParse({...base,candidate_summary:summary}).success);
});
