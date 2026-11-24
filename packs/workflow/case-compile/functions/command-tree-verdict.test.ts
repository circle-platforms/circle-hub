import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertion,call,fixture,plan as blockPlan,quote as blockQuote} from '../testing/blocks.ts';
import {frozenRun} from '../testing/frozen-run.ts';
import {lockedTreeOf,type FlatCatalog} from '../testing/locked-tree.ts';
import {commandTreeAnswer,commandTreeCheck,judgeStep,treeOnlyStep,type CommandTreeCheck,type TreeAnswer} from './command-tree-verdict.ts';
import {planBoundary} from './plan-boundary.ts';
import {COMMAND_CATALOG,CONTRACT_DOC,LEGACY_CONTRACT_DOC,LEGACY_PROFILE_DOC,MANIFEST_DOC,PROFILE_DOC,QUOTE,goodData} from './test-support.ts';

const LEASES={now:'2026-10-23T02:00:00.000Z',entries:[]};
const flatRun=(contract:unknown=CONTRACT_DOC,profile:unknown=PROFILE_DOC)=>frozenRun({groups:[{kind:'case-compile',contract,profile,manifest:MANIFEST_DOC,leases:LEASES}],items:[{id:'doc:case-1',label:'合成用例',location:QUOTE.reference,fields:{}}],root:(COMMAND_CATALOG as {root:string}).root,command_policy:(COMMAND_CATALOG as {policy:unknown}).policy});
const flatSlots=(data=goodData())=>({plan:[{text:'合成计划',quotes:[QUOTE],data}]});
const flatTree=lockedTreeOf(COMMAND_CATALOG as FlatCatalog);
const flat=(data=goodData())=>commandTreeCheck({run:flatRun(),item:'doc:case-1',slots:flatSlots(data),catalog:flatTree});
const problem=(pointer:string,verdict='refute',message='合成问题')=>({pointer,message,verdict,code:'case-compile.method_forbidden'});
const made=(problems:CommandTreeCheck['problems']):CommandTreeCheck=>({ran:true,problems});

test('a plan whose commands the locked tree resolves is accepted at every step',()=>{
 const check=flat();
 assert.equal(check.ran,true,check.why);assert.deepEqual(check.problems,[]);
 for(const scope of ['/steps/0','/steps/1','/steps/2'])assert.deepEqual(commandTreeAnswer(check,scope),{status:'accepted'},scope);
});

test('a command the tree does not know is refused at its own step with the problem the plan check names, and no other step is',()=>{
 const data=goodData();data.steps[0]!.args=['widget unknown command 5'];
 const check=flat(data);
 assert.equal(check.ran,true);assert.ok(check.problems.some(row=>row.pointer==='/steps/0/args/0'),JSON.stringify(check.problems));
 const own=commandTreeAnswer(check,'/steps/0');
 assert.equal(own.status,'refused');assert.ok(own.problems!.length>0&&own.problems!.every(row=>row.pointer.startsWith('/steps/0')),JSON.stringify(own));assert.ok(own.problems![0]!.message.length>0);
 assert.deepEqual(commandTreeAnswer(check,'/steps/1'),{status:'accepted'});
});

test('the check is the one check-plan runs: only commands_catalog, on the frozen run and its locked tree',()=>{
 const data=goodData();data.replacements=[{case:'192.0.2.200',bed:'192.0.2.91'}];
 assert.deepEqual(flat(data).problems,[],'another Hub check does not speak for the command tree');
});

test('planBoundary runs and lists only the checks it is asked for, and all of them when it is asked for none in particular',()=>{
 const input={run:flatRun(),item:'doc:case-1',slots:flatSlots(),catalog:flatTree};
 assert.deepEqual(planBoundary({...input,checks:['commands_catalog']}).coverage.map(row=>row.check),['commands_catalog']);
 assert.deepEqual(planBoundary({...input,checks:['commands_catalog','bed_addresses']}).coverage.map(row=>row.check),['bed_addresses','commands_catalog'],'in the order of checks.json');
 const every=planBoundary(input).coverage.map(row=>row.check);
 assert.ok(every.length>3&&every.includes('commands_catalog')&&every.includes('contract_shape'),every.join());
 assert.deepEqual(planBoundary({...input,checks:[]}).coverage,[],'naming no check runs none');
});

test('a step is judged by its own pointer: a refusal of step 10 is not a refusal of step 1, and a block is judged by its whole block',()=>{
 const check=made([problem('/steps/10/args/0')]);
 assert.deepEqual(commandTreeAnswer(check,'/steps/1'),{status:'accepted'});assert.equal(commandTreeAnswer(check,'/steps/10').status,'refused');
 const blocks=made([problem('/blocks/2/call/args/0'),problem('/blocks/3/assertions/0')]);
 assert.equal(commandTreeAnswer(blocks,'/blocks/2/call').status,'refused');assert.equal(commandTreeAnswer(blocks,'/blocks/2').status,'refused');
 assert.equal(commandTreeAnswer(blocks,'/blocks/3').status,'refused','a problem of the block is a problem of the block');
 assert.deepEqual(commandTreeAnswer(blocks,'/blocks/20/call'),{status:'accepted'});assert.deepEqual(commandTreeAnswer(blocks,'/blocks/1/call'),{status:'accepted'});
});

test('what the tree could not settle is undetermined, never accepted: an unknown at the step, or a problem that belongs to no step',()=>{
 const unknown=commandTreeAnswer(made([problem('/steps/0/args/0','unknown','缺少事实')]),'/steps/0');
 assert.equal(unknown.status,'undetermined');assert.match(unknown.reason!,/缺少事实/);
 const elsewhere=made([problem('/profile/allowed/3','unknown','缺合约类型'),problem('/steps/4/args/0')]);
 for(const scope of ['/steps/0','/steps/4']){const answer=commandTreeAnswer(elsewhere,scope);assert.notEqual(answer.status,'accepted',scope);}
 assert.equal(commandTreeAnswer(elsewhere,'/steps/0').status,'undetermined');assert.match(commandTreeAnswer(elsewhere,'/steps/0').reason!,/缺合约类型/);
 assert.equal(commandTreeAnswer(elsewhere,'/steps/4').status,'refused','a refusal of the step stays a refusal');
});

test('a check that could not run says why and speaks for no step',()=>{
 const none=commandTreeCheck({run:flatRun(),item:'doc:case-1',slots:flatSlots(),catalog:undefined});
 assert.equal(none.ran,false);assert.match(none.why!,/命令树/);
 const answer=commandTreeAnswer(none,'/steps/0');assert.equal(answer.status,'not_run');assert.equal(answer.reason,none.why);
 for(const run of [undefined,null,{run:'run_synthetic'},{...flatRun(),items:[]}]){
  const check=commandTreeCheck({run,item:'doc:case-1',slots:flatSlots(),catalog:flatTree});
  assert.equal(check.ran,false,JSON.stringify(run)?.slice(0,60));assert.ok(check.why&&check.why.length>6);assert.equal(commandTreeAnswer(check,'/steps/0').status,'not_run');
 }
 const broken=flatSlots();delete (broken.plan[0] as Record<string,unknown>).text;
 const refused=commandTreeCheck({run:flatRun(),item:'doc:case-1',slots:broken,catalog:flatTree});
 assert.equal(refused.ran,false);assert.match(refused.why!,/槽位/);
});

test('a contract without typed authority leaves the commands undetermined instead of accepting them',()=>{
 const check=commandTreeCheck({run:flatRun(LEGACY_CONTRACT_DOC,LEGACY_PROFILE_DOC),item:'doc:case-1',slots:flatSlots(),catalog:flatTree});
 assert.equal(check.ran,true);
 assert.notEqual(commandTreeAnswer(check,'/steps/0').status,'accepted',JSON.stringify(check.problems));
});

test('block plans are judged the same way, by the block that holds the command',()=>{
 const f=fixture();
 const run=frozenRun({groups:[{kind:'case-compile',contract:f.contractDoc,profile:f.profileDoc,manifest:f.inventory,manifest_sha256:f.manifest_sha256,leases:LEASES}],items:[{id:'synthetic-case',label:'合成块计划',location:'src:'+'a'.repeat(64)+'/kityminder@1/n/expected',fields:f.fields}],root:f.catalog.root,command_policy:(f.catalog as {policy:unknown}).policy});
 const tree=lockedTreeOf(f.catalog as unknown as FlatCatalog);
 const slots=(blocks:Array<Record<string,unknown>>)=>({plan:[{text:'合成块计划',quotes:[blockQuote()],data:blockPlan(blocks)}]});
 const observe={kind:'OBSERVE_ASSERT',id:'observe',call:call('demo show'),assertions:[assertion('assertA','observe')]};
 const good=commandTreeCheck({run,item:'synthetic-case',slots:slots([observe]),catalog:tree});
 assert.equal(good.ran,true,good.why);
 assert.equal(commandTreeAnswer(good,'/blocks/0/call').status,'accepted',JSON.stringify(good.problems));
 const bad=commandTreeCheck({run,item:'synthetic-case',slots:slots([{kind:'CONFIG',id:'configure',call:call('demo nothing 9')},observe]),catalog:tree});
 assert.equal(bad.ran,true);assert.equal(commandTreeAnswer(bad,'/blocks/0/call').status,'refused',JSON.stringify(bad.problems));
});

const OVERRIDE='Plumb 判断（未确认）与命令树核对不一致；命令树核对通过，以命令树为准，需人工复核';
const NOTE={reject:'Plumb match 落入 reject 区',review:'[需人工复核：Plumb match 落入 review 区]',pass:null} as const;
const TREE:Record<string,TreeAnswer>={accepted:{status:'accepted'},refused:{status:'refused',problems:[problem('/steps/0/args/0','refute','命令不在锁定命令树里')]},undetermined:{status:'undetermined',reason:'缺合约类型'},not_run:{status:'not_run',reason:'没有冻结运行'}};

test('the program has the last word on a command: what Plumb says and what the tree says make one verdict, in every combination',()=>{
 for(const strict of [false,true]){
  const overridden=judgeStep({call:'reject',note:NOTE.reject},TREE.accepted!,strict);
  assert.deepEqual([overridden.verdict,overridden.review_required,overridden.blocked],['review',true,strict],'tree accepts: review, blocked only when strict');
  assert.equal(overridden.disclosure,OVERRIDE);assert.equal(overridden.note,'[需人工复核：Plumb 拒绝，命令树核对通过]');
  assert.equal(judgeStep({call:'reject',note:NOTE.reject,yes:0.0333},TREE.accepted!,strict).note,'[需人工复核：Plumb 拒绝（p(是)=0.033），命令树核对通过]','the Plumb probability is in the note beside the verdict');
  const both=judgeStep({call:'reject',note:NOTE.reject},TREE.refused!,strict);
  assert.deepEqual([both.verdict,both.review_required,both.blocked],['reject',false,true]);assert.match(both.note!,/命令树核对未通过.*命令不在锁定命令树里/);
  for(const name of ['undetermined','not_run']){
   const alone=judgeStep({call:'reject',note:NOTE.reject},TREE[name]!,strict);
   assert.deepEqual([alone.verdict,alone.review_required,alone.blocked,alone.note],['reject',false,true,NOTE.reject],name+': nothing but Plumb has spoken, so the reject stands as before');
   assert.match(alone.disclosure!,/命令树核对没有给出结论/);assert.ok(alone.disclosure!.includes(TREE[name]!.reason!));
  }
  for(const name of ['accepted','undetermined','not_run']){
   const same=judgeStep({call:'review',note:NOTE.review},TREE[name]!,strict);
   assert.deepEqual([same.verdict,same.review_required,same.blocked,same.note,same.disclosure],['review',true,strict,NOTE.review,undefined],name);
  }
  for(const name of ['accepted','undetermined','not_run']){
   const same=judgeStep({call:'pass',note:null},TREE[name]!,strict);
   assert.deepEqual([same.verdict,same.review_required,same.blocked,same.note,same.disclosure],['pass',false,false,undefined,undefined],name);
  }
  for(const call of ['pass','review'] as const){
   const refused=judgeStep({call,note:NOTE[call]},TREE.refused!,strict);
   assert.deepEqual([refused.verdict,refused.review_required,refused.blocked],['reject',false,true],call);assert.match(refused.note!,/命令树核对未通过/);
  }
 }
});

test('without Plumb the tree alone decides: refused blocks, accepted passes, and what it cannot settle stays unknown and is disclosed instead of passing as judged',()=>{
 const refused:TreeAnswer={status:'refused',problems:[problem('/steps/0/args/0')]};
 assert.deepEqual(treeOnlyStep(refused,false),{verdict:'reject',blocked:true,review_required:false,note:'命令树核对未通过（程序判定）：合成问题'});
 assert.deepEqual(treeOnlyStep({status:'accepted'},false),{verdict:'pass',blocked:false,review_required:false});
 for(const status of ['undetermined','not_run'] as const){
  const open=treeOnlyStep({status,reason:'缺这一步的事实'},false);
  assert.equal(open.verdict,'review');assert.equal(open.blocked,false);assert.equal(open.review_required,true);
  assert.match(open.disclosure!,/命令树核对没有给出结论（缺这一步的事实）/);assert.match(open.disclosure!,/不问 Plumb/);assert.match(open.disclosure!,/状态未知/);
  assert.equal(treeOnlyStep({status,reason:'缺这一步的事实'},true).blocked,true,'--strict-review blocks what nobody judged');
 }
});
