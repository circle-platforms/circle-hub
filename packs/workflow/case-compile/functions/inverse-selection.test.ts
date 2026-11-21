// A plan that turns a switch on owes the switch off, in reverse order, before the runner clears the device (T9 supplement 7). The
// Hub judges a plan on the catalog its selection reads, not on the whole tree: the check's catalog_select function names what the plan
// sends and what the product's declared inverses of those commands ask for, and the Hub's walk of the locked tree returns only that.
// Round 30 to 32 sent plans with `ha on` and no `ha off`: the sibling `ha off` was not selected, so the cleanup check could not find
// the declared inverse and the runner's own clear was taken to be enough, while check-plan, given the whole tree, refused the same
// plan. The Hub's selection is run here with the Hub's own functions (testing/hub-side.ts, no database; hub-parity.test.ts runs the
// real engine), beside check-plan, on synthetic commands only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectCommandCatalog} from './subject.ts';
import {runtimeDigest} from './runtime-contract.ts';
import {QUOTE} from './test-support.ts';
import {fixture,cleanup,catalog,policy} from '../testing/inverse-alternatives.ts';
import {frozenRun} from '../testing/frozen-run.ts';
import {lockedTreeOf,treeLines,type FlatCatalog} from '../testing/locked-tree.ts';
import {hubSide,ENGINE_LIMIT} from '../testing/hub-side.ts';
import {checkPlanObject} from '../tools/check-plan.ts';

type Step=Parameters<typeof fixture>[0][number];
type Doc=Record<string,any>;
const param=(index:number)=>({id:'1',reference:`src:${'b'.repeat(64)}/xml@1/x/commands/item[${index}]/arguments`,params:[]});
const clearAll={words:['clear','demo','all'],signatures:[param(99)]};

/**
 * One plan against one frozen run, as the writer would hand it in: the contract of the fixture with the runner's own cleanup
 * declared for the device (the runner clears every command under `demo`, as the real one clears the commands of its prefixes), the
 * product policy of the fixture, and the tree of the catalog. `extra` adds commands to the tree and to the contract's scope.
 */
function scenario(steps:Step[],options:{runner?:boolean;catalog?:FlatCatalog;scope?:string[];readOnly?:string[]}={}){
 const value=fixture(steps),contract=value.subject.contract as Doc,flat=options.catalog??catalog;
 if(options.runner!==false)contract.cleanup={source:'fixture/clear',sha256:'a'.repeat(64),objects:['widget-seat'],rules:[{prefixes:['demo'],clears:['clear demo all']}]};
 contract.effects.effect_0.command_scope.push(...options.scope??[]);contract.contract_sha256=runtimeDigest(contract);
 const rules=structuredClone(policy) as Doc;rules.read_only.push(...options.readOnly??[]);
 const run=frozenRun({groups:[{kind:'case-compile',contract,profile:value.subject.profile,manifest:value.subject.manifest}],items:[{id:'synthetic-item'}],root:flat.root,command_policy:rules});
 const slots={plan:[{text:'合成计划',data:{...(value.subject.data as Doc),expects:[{text:QUOTE.text,quote:{...QUOTE},after:1}]}}]};
 return {run,slots,plan:{item:'synthetic-item',handling:'handled',slots},flat};
}
const withClear={catalog:{...catalog,entries:[...catalog.entries,clearAll]} as FlatCatalog,scope:['/commands/clear'],readOnly:['/commands/clear']};
// The Hub reports a problem once for each check that finds it and check-plan once in all: the same problems are the same set.
const canonical=(rows:unknown[])=>[...new Set(rows.map(row=>JSON.stringify(row,(_key,value)=>value!==null&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:1)):value)))].sort();
const problemKey=(row:{code?:string;pointer:string;message:string})=>({code:row.code??null,pointer:row.pointer,message:row.message});

/** What the Hub's checks and check-plan each say about the same plan on the same locked tree. */
async function decide(steps:Step[],options:Parameters<typeof scenario>[1]={}){
 const made=scenario(steps,options),hub=await hubSide(made.run,'synthetic-item',made.slots,treeLines(made.flat));
 const local=checkPlanObject('plan.json',made.plan,made.run,lockedTreeOf(made.flat));
 return {hub,local,made,hubProblems:hub.problems.map(problemKey),localProblems:local.problems.map(problemKey)};
}
const says=(rows:Array<{message:string}>,text:string)=>rows.some(row=>row.message.includes(text));

test('the catalog the Hub selects holds the sibling a plan\'s switch is undone with, and the plan\'s own lines are not asked twice',async()=>{
 const bad=await decide(['demo switch on','demo relay enable']);
 const [selection]=bad.hub.selections;
 assert.ok(selection.lines.includes('demo switch off'),JSON.stringify(selection.lines));
 assert.ok(selection.lines.includes('demo relay disable'),JSON.stringify(selection.lines));
 assert.ok('entries' in selection.view);
 const heads=(selection.view as unknown as {entries:Array<{words:string[]}>}).entries.map(entry=>entry.words.join(' '));
 for(const head of ['demo switch on','demo switch off','demo relay enable','demo relay disable'])assert.ok(heads.includes(head),`${head} is in what the checks receive: ${heads.join(', ')}`);
 // The partner the plan itself sends, as the cleanup or in any other place, is already walked.
 const good=await decide(['demo switch on',cleanup('demo switch off')]);
 assert.deepEqual(good.hub.selections[0].lines.filter(line=>line.startsWith('demo switch')).sort(),['demo switch off','demo switch on']);
});

test('a plan that turns a switch on and never off is refused by the Hub\'s checks as by check-plan, and accepted with the inverse in its cleanup',async()=>{
 for(const [on,off] of [['demo switch on','demo switch off'],['demo relay enable','demo relay disable'],['demo feature on','demo feature off']]){
  const bad=await decide([on]);
  assert.ok(says(bad.hubProblems,off),`${on}: the Hub's checks name the cleanup owed (${off}): ${JSON.stringify(bad.hubProblems)}`);
  assert.ok(bad.hubProblems.every(row=>row.code==='case-compile.method_forbidden'),JSON.stringify(bad.hubProblems));
  assert.deepEqual(canonical(bad.localProblems),canonical(bad.hubProblems),`${on}: check-plan decides as the Hub does`);
  assert.equal(bad.local.ok,false);
  const good=await decide([on,cleanup(off)]);
  assert.deepEqual(good.hubProblems,[],`${on} with ${off}: ${JSON.stringify(good.hubProblems)}`);
  assert.deepEqual(good.localProblems,[]);assert.equal(good.local.ok,true);
 }
});

test('the inverse is owed on the device that configured it, before the runner\'s clear, and an inverse before the clear is accepted',async()=>{
 const late=await decide(['demo switch on','clear demo all',cleanup('demo switch off')],withClear);
 assert.ok(says(late.hubProblems,'先执行同设备的产品声明逆操作'),JSON.stringify(late.hubProblems));
 assert.deepEqual(canonical(late.localProblems),canonical(late.hubProblems));
 const early=await decide(['demo switch on','demo switch off','clear demo all'],withClear);
 assert.deepEqual(early.hubProblems,[],JSON.stringify(early.hubProblems));assert.deepEqual(early.localProblems,[]);
 // Two switches are undone in reverse order of their configuration, and the order is part of what the Hub checks.
 const reversed=await decide(['demo switch on','demo relay enable',cleanup('demo relay disable'),cleanup('demo switch off')]);
 assert.deepEqual(reversed.hubProblems,[],JSON.stringify(reversed.hubProblems));assert.deepEqual(reversed.localProblems,[]);
 const crossed=await decide(['demo switch on','demo relay enable',cleanup('demo switch off'),cleanup('demo relay disable')]);
 assert.ok(crossed.hubProblems.length>0,'cleanup in the order of configuration is refused');assert.deepEqual(canonical(crossed.localProblems),canonical(crossed.hubProblems));
});

test('the declared prefix rules and the enum arguments decide as before, here and there',async()=>{
 const rule=await decide(['demo pool add one 10'],{runner:false});
 assert.ok(says(rule.hubProblems,'缺同设备、逆序的清理操作'),JSON.stringify(rule.hubProblems));
 assert.deepEqual(canonical(rule.localProblems),canonical(rule.hubProblems));
 const done=await decide(['demo pool add one 10',cleanup('no demo pool add one')],{runner:false});
 assert.deepEqual(done.hubProblems,[],JSON.stringify(done.hubProblems));assert.deepEqual(done.localProblems,[]);
 // A switch without a runner clear behind it is owed its inverse too, and the answer is the same with or without the clear.
 const bare=await decide(['demo switch on'],{runner:false});
 assert.ok(says(bare.hubProblems,'demo switch off'),JSON.stringify(bare.hubProblems));assert.deepEqual(canonical(bare.localProblems),canonical(bare.hubProblems));
});

test('the sibling lines are never dropped: when they do not fit the limit the selection is refused as too large and nothing is accepted',async()=>{
 const banks=Array.from({length:70},(_,index)=>({words:['demo','bank'+index,'on'],signatures:[param(100+index)]}));
 const peers=Array.from({length:70},(_,index)=>({words:['demo','bank'+index,'off'],signatures:[param(200+index)]}));
 const big:FlatCatalog={...catalog,entries:[...catalog.entries,...banks,...peers]};
 const steps=Array.from({length:70},(_,index)=>`demo bank${index} on`);
 const options={catalog:big,scope:['/commands/demo']};
 const made=scenario(steps,options),raw={context:{root:big.root,command_policy:made.run.command_policy,groups:made.run.groups},item:{id:'synthetic-item'},slots:made.slots};
 const asked=(selectCommandCatalog(raw) as {lines:string[]}).lines;
 assert.equal(asked.length,140,'70 lines of the plan and the 70 siblings they are undone with');
 const over=await decide(steps,options);
 const [selection]=over.hub.selections;
 assert.deepEqual(selection.view,{missing:ENGINE_LIMIT},'the engine refuses a selection over 128 lines');
 assert.ok(over.hubProblems.some(row=>row.message===ENGINE_LIMIT),JSON.stringify(over.hubProblems.slice(0,3)));
 assert.ok(over.hub.problems.every(row=>row.verdict==='unknown'),'it is unknown, with the next step to split the plan, never a pass and never a failure of the plan');
 assert.deepEqual(canonical(over.localProblems),canonical(over.hubProblems),'check-plan says the same');
 // A plan of half that size, each switch undone in reverse order, is read and judged: nothing is owed.
 const on=steps.slice(0,30),fits=await decide([...on,...on.map(step=>cleanup(step.replace(' on',' off'))).reverse()],options);
 assert.ok(fits.hub.selections.every(entry=>'entries' in entry.view),'the selection of 60 lines is read');
 assert.deepEqual(fits.hubProblems,[],JSON.stringify(fits.hubProblems.slice(0,3)));assert.deepEqual(fits.localProblems,[]);
});

test('the prefix rules\' lines are all or none, and the sibling lines come first and in full',async()=>{
 const rules=[...Array.from({length:60},(_,index)=>`demo pool add n${index} ${index}`)];
 const made=scenario([...rules,'demo switch on'],{runner:false});
 const raw={context:{root:made.flat.root,command_policy:made.run.command_policy,groups:made.run.groups},item:{id:'synthetic-item'},slots:made.slots};
 const asked=(selectCommandCatalog(raw) as {lines:string[]}).lines;
 // 61 lines of the plan + 1 sibling + 60 rule lines would be 122: all of them fit.
 assert.equal(asked.length,61+1+60);assert.ok(asked.includes('demo switch off'));
 const more=scenario([...rules,...Array.from({length:6},(_,index)=>`demo pool add m${index} ${index}`),'demo switch on'],{runner:false});
 const asked2=(selectCommandCatalog({context:{root:more.flat.root,command_policy:more.run.command_policy,groups:more.run.groups},item:{id:'synthetic-item'},slots:more.slots}) as {lines:string[]}).lines;
 // 67 lines + 1 sibling + 66 rule lines are over 128: the rule lines are dropped, the sibling is kept.
 assert.equal(asked2.length,67+1);assert.ok(asked2.includes('demo switch off'));
});
