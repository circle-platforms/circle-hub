// The owner's 2026-11-16 decision: for an expectation whose author wrote no literal, the model writes the checkpoint itself
// (for example: the answer contains a record name) and nothing is reviewed. A block plan states that checkpoint as a typed
// criterion beside the verbatim quote; it is a model judgment, status unconfirmed, and the device run decides. A flat plan
// already did this with basis:"model_judgment". Everything here is synthetic.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {fixture,plan,call,assertion,EXPECTED_REF,BLOCK_ROOT} from '../testing/blocks.ts';
import {checkExpectedSources} from './checks.ts';
import {readSlots} from './slots.ts';
import {labelOf} from './generated/vocabulary.ts';
import type {PlanSlots} from './slots.ts';

const f=fixture();
// The author's expectation is a sentence without a literal: the frozen node carries no declaration.
const SENTENCE='合成应答带有签名记录',LITERAL='SYNTH-SIG',RATIONALE='模型选择应答里的签名记录名作为检查点；这是模型判断，由上机验证裁定';
const quote=()=>({reference:EXPECTED_REF,text:SENTENCE});
const nodes=()=>[{reference:EXPECTED_REF,text:SENTENCE}];
const criterion=(over:Record<string,unknown>={})=>({id:'c_sig',expectation:EXPECTED_REF,quote:quote(),kind:'literal',operator:'abs_found',literal:LITERAL,rationale:RATIONALE,scope_root:BLOCK_ROOT,...over});
/** A block plan that grounds the sentence on a checkpoint the model wrote itself. */
function blockPlan(literal=LITERAL,over:Record<string,unknown>={}):PlanSlots{
 const data=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[{...assertion('a_sig','observe','abs_found'),literal,quote:quote(),expectation:EXPECTED_REF,criterion:'c_sig'}]}]);
 data.criteria=[criterion({literal,...over})];
 return data;
}
/** The same sentence on a flat plan: one command, one expectation naming the model's checkpoint. */
function flatPlan(text=LITERAL,over:Record<string,unknown>={}):PlanSlots{
 return {bucket:'bed-a',blocks:[],replacements:[],steps:[call()],expects:[{text,quote:quote(),after:1,basis:'model_judgment',rationale:RATIONALE,...over}]} as PlanSlots;
}
const check=(data:PlanSlots,extra:Record<string,unknown>={})=>checkExpectedSources(f.subject(data,{expected_nodes:nodes(),...extra}));
const verdicts=(data:PlanSlots,extra:Record<string,unknown>={})=>check(data,extra).map(row=>row.verdict);

/** What the independent review stage would hand back for an accepted criterion (the shape the stage's own tests use). */
function review(declaration:Record<string,unknown>,change:(claim:any,run:any)=>void=()=>{}){
 const run={run:'run_00000000000000000000000002',predecessor:'run_00000000000000000000000001',runner:'synthetic-reviewer',pack:TABLE.review_pack.id+'@'+TABLE.review_pack.version,pack_digest:'b'.repeat(64),items:[{id:'criterion',fields:{criterion:declaration,author_run:'run_00000000000000000000000001'}}]};
 const claim={statement:{code:'accept'},warrant:{producer:'model',id:'synthetic-model',independence:'human_non_author'},qualifier:{nature:'judgment'},validity:{status:'valid'}};
 const result={schema:'validation@1',run:run.run,acceptance:'accepted',locks:{pack:run.pack,pack_digest:run.pack_digest},partitions:{delivered:[{item:'criterion',requirements:[{requirement:'review',status:'satisfied',claims:[claim]}]}]}};
 change(claim,run);
 return {run:{external:null,meta:{kind:'run',record:'c'.repeat(64)},model:{kind:'run',body:run}},result:{external:null,meta:{kind:'validation_result',record:'d'.repeat(64)},model:{kind:'validation_result',body:result}}};
}

test('control: the same descriptive expectation with an accepted independent review is grounded as before',()=>{
 const out=check(blockPlan(),{criteria_review:review(criterion())});
 assert.deepEqual(out.map(row=>row.verdict),['support'],JSON.stringify(out));
 const data=out[0].data as {typed_criteria:Array<Record<string,unknown>>;model_criteria?:unknown};
 assert.equal(data.typed_criteria.length,1);assert.equal(data.typed_criteria[0].reviewer,'synthetic-reviewer');assert.equal(data.model_criteria,undefined);
});

for(const [name,evidence] of [['nothing is bound',undefined],['the Hub froze an empty pair',{result:null,run:null}]] as const)test('a typed criterion the model wrote itself is accepted without a review when '+name,()=>{
 const out=check(blockPlan(),evidence===undefined?{}:{criteria_review:evidence});
 assert.deepEqual(out.map(row=>row.verdict),['support'],JSON.stringify(out));
 const row=out[0],data=row.data as {typed_criteria:unknown[];model_criteria:Array<Record<string,unknown>>};
 // the claim is the model's judgment, unconfirmed, and nothing pretends it was reviewed
 assert.deepEqual(data.typed_criteria,[]);assert.equal(data.model_criteria.length,1);
 const judged=data.model_criteria[0];
 assert.deepEqual({criterion:judged.criterion,expectation:judged.expectation,assertion:judged.assertion,basis:judged.basis,literal:judged.literal,reviewed:judged.reviewed,status:judged.status,decided_by:judged.decided_by,conditional_on_judgment:judged.conditional_on_judgment},{criterion:'c_sig',expectation:EXPECTED_REF,assertion:'a_sig',basis:'model_judgment',literal:LITERAL,reviewed:false,status:'未确认',decided_by:labelOf('producer_kind','model'),conditional_on_judgment:true});
 assert.equal(judged.rationale,RATIONALE);assert.deepEqual(judged.quote,quote());
 for(const word of [labelOf('expectation_basis','model_judgment'),labelOf('qualifier_mark','conditional_on_judgment'),'未确认','上机验证','独立复核'])assert.ok(row.statement.includes(word),word+' / '+row.statement);
 assert.deepEqual(row.judgment_sources,['/plan/0']);
 assert.equal(row.tier,'blocking');
});

test('the checkpoint stays a parsed literal: the assertion and its criterion must name the same checkable value',()=>{
 for(const [name,mutate] of [
  ['another literal in the criterion',(data:PlanSlots)=>{data.criteria![0].literal='SYNTH-KEY';}],
  ['another operator',(data:PlanSlots)=>{data.criteria![0].operator='found';}],
  ['another kind',(data:PlanSlots)=>{data.criteria![0].kind='count';}],
  ['a quote that is not the assertion\'s',(data:PlanSlots)=>{data.criteria![0].quote={reference:EXPECTED_REF,text:'另一句'};}],
  ['another locked root',(data:PlanSlots)=>{data.criteria![0].scope_root='e'.repeat(64);}],
  ['another expectation',(data:PlanSlots)=>{data.criteria![0].expectation=EXPECTED_REF+'/other';}],
 ] as Array<[string,(data:PlanSlots)=>void]>){
  const data=blockPlan();mutate(data);
  const out=check(data);assert.ok(out.length>0&&out.every(row=>row.verdict!=='support'),name+': '+JSON.stringify(out));
  assert.ok(out.some(row=>row.verdict==='refute'),name+': '+JSON.stringify(out));
 }
});

for(const literal of ['SYNTH-SIG\nSYNTH-KEY','=SYNTH-SIG','SYNTH-SIG {0}','SYNTH-SIG {}',' SYNTH-SIG ','SYNTH-SIG\t'])test('a model-written checkpoint that is not a single-line value is refused in block and flat plans alike: '+JSON.stringify(literal),()=>{
 const block=check(blockPlan(literal)),flat=check(flatPlan(literal));
 assert.ok(block.some(row=>row.verdict==='refute')&&block.every(row=>row.verdict!=='support'),JSON.stringify(block));
 assert.ok(flat.some(row=>row.verdict==='refute')&&flat.every(row=>row.verdict!=='support'),JSON.stringify(flat));
});

test('the quote still binds the author\'s own expectation word for word',()=>{
 for(const [name,value] of [['a sentence the author did not write','另一句期望'],['the title instead of the expectation','合成 ORBIT/COMET 用例']] as const){
  const data=blockPlan();data.blocks[0].assertions[0].quote={reference:EXPECTED_REF,text:value};data.criteria![0].quote={reference:EXPECTED_REF,text:value};
  const out=check(data);assert.ok(out.some(row=>row.verdict==='refute'&&row.code==='case-compile.expect_not_in_quote'),name+': '+JSON.stringify(out));assert.ok(out.every(row=>row.verdict!=='support'),name);
 }
 // another case's node is not this case's expectation
 const elsewhere=blockPlan();assert.ok(check(elsewhere,{expected_nodes:[{reference:EXPECTED_REF+'/other',text:SENTENCE}]}).every(row=>row.verdict!=='support'));
});

test('an expectation without a typed criterion is not given one: it stays unknown and the next step names no review',()=>{
 const data=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[{...assertion('a_sig','observe','abs_found'),literal:LITERAL,quote:quote(),expectation:EXPECTED_REF}]}]);
 const out=check(data);assert.deepEqual(out.map(row=>row.verdict),['unknown'],JSON.stringify(out));
 const missing=out[0].missing!;assert.ok(missing.includes('类型化判据'),missing);assert.ok(!missing.includes('复核'),missing);
 for(const word of ['criteria','未确认','上机验证'])assert.ok(missing.includes(word),word+' / '+missing);
});

test('a review that is bound is still verified as before: a refusal is not bypassed by falling back to the model\'s judgment',()=>{
 const rejected=check(blockPlan(),{criteria_review:review(criterion(),claim=>{claim.statement.code='reject';})});
 assert.deepEqual(rejected.map(row=>row.verdict),['unknown'],JSON.stringify(rejected));
 const own=check(blockPlan(),{criteria_review:review(criterion(),claim=>{claim.warrant.independence='not_independent';})});
 assert.deepEqual(own.map(row=>row.verdict),['unknown'],JSON.stringify(own));
 const half=check(blockPlan(),{criteria_review:{result:review(criterion()).result,run:null}});
 assert.deepEqual(half.map(row=>row.verdict),['unknown'],JSON.stringify(half));
 const other=check(blockPlan(),{criteria_review:{result:null,run:review(criterion()).run}});
 assert.deepEqual(other.map(row=>row.verdict),['unknown'],JSON.stringify(other));
 // evidence that is not the frozen pair at all is not "no review" either
 for(const odd of ['x',[],0,true])assert.deepEqual(check(blockPlan(),{criteria_review:odd}).map(row=>row.verdict),['unknown'],JSON.stringify(odd));
 // the refusal tells the writer both ways out: bind the whole review, or bind none and let the model's judgment stand
 for(const row of [...rejected,...half])assert.ok(row.missing!.includes('criteria_review')&&row.missing!.includes('模型判断'),row.missing);
});

test('flat and block plans agree on the same descriptive expectation',()=>{
 const block=check(blockPlan()),flat=check(flatPlan());
 assert.deepEqual(block.map(row=>row.verdict),['support'],JSON.stringify(block));assert.deepEqual(flat.map(row=>row.verdict),['support'],JSON.stringify(flat));
 for(const row of [block[0],flat[0]]){
  for(const word of [labelOf('expectation_basis','model_judgment'),labelOf('qualifier_mark','conditional_on_judgment')])assert.ok(row.statement.includes(word),word+' / '+row.statement);
  assert.ok(row.judgment_sources!.length>0);assert.equal(row.tier,'blocking');
 }
 // both keep the model's reason and the author's quote beside the checkpoint
 const flatJudged=(flat[0].data as {model_expectations:Array<Record<string,any>>}).model_expectations[0],blockJudged=(block[0].data as {model_criteria:Array<Record<string,any>>}).model_criteria[0];
 assert.equal(flatJudged.rationale,blockJudged.rationale);assert.deepEqual(flatJudged.quote,blockJudged.quote);assert.equal(flatJudged.basis,blockJudged.basis);
 // the lowered block assertion carries the same declaration a flat expectation carries: the model's basis and its own reason
 const lowered=readSlots(blockPlan());assert.ok(lowered.ok);if(lowered.ok){const expect=lowered.slots.expects[0];assert.equal(expect.basis,'model_judgment');assert.equal(expect.rationale,RATIONALE);assert.ok(!expect.rationale!.includes('独立复核'));}
 // the same input changes make both refuse, or both report the same missing fact
 const same:Array<[string,PlanSlots,PlanSlots,Record<string,unknown>]>=[
  ['a quote that is not the author\'s',(()=>{const d=blockPlan();d.blocks[0].assertions[0].quote={reference:EXPECTED_REF,text:'别的句子'};d.criteria![0].quote={reference:EXPECTED_REF,text:'别的句子'};return d;})(),flatPlan(LITERAL,{quote:{reference:EXPECTED_REF,text:'别的句子'}}),{}],
  ['a literal that is not one line',blockPlan('a\nb'),flatPlan('a\nb'),{}],
  ['the author\'s node missing',blockPlan(),flatPlan(),{expected_nodes:undefined}],
 ];
 for(const [name,b,fl,extra] of same)assert.deepEqual(verdicts(b,extra),verdicts(fl,extra),name);
});

test('the lowered assertion states the model\'s own reason, not a pending review',()=>{
 const data=blockPlan();const parsed=readSlots(data);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return;
 assert.equal(parsed.slots.expects.length,1);assert.equal(parsed.slots.expects[0].criterion,'c_sig');
 assert.equal(parsed.slots.expects[0].rationale,RATIONALE);
 // an assertion without a criterion keeps no model basis
 const author=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[assertion()]}]);const read=readSlots(author);assert.ok(read.ok);if(read.ok){assert.equal(read.slots.expects[0].basis,undefined);assert.equal(read.slots.expects[0].rationale,undefined);}
});

test('a model-written checkpoint states its reason: a blank rationale is refused in block and flat plans alike',()=>{
 for(const blank of ['',' ','\n\t']){
  const block=blockPlan(LITERAL,{rationale:blank});const read=readSlots(block);
  if(blank==='')assert.equal(read.ok,false);// the shape already needs a reason
  else{assert.equal(read.ok,false,JSON.stringify(blank));if(!read.ok)assert.ok(read.problems.some(problem=>problem.pointer==='/criteria/0/rationale'),JSON.stringify(read.problems));}
  assert.equal(readSlots(flatPlan(LITERAL,{rationale:blank})).ok,false,JSON.stringify(blank));
  const out=check(block);assert.ok(out.every(row=>row.verdict!=='support'),JSON.stringify(blank));
 }
});
