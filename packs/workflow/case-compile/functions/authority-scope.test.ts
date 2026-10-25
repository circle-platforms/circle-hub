import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkCommandsKnown,checkContractShape} from './checks.ts';
import {goodData,subjectOf,CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,COMMAND_CATALOG,COMMAND_IDENTITIES} from './test-support.ts';
import {runtimeDigest} from './runtime-contract.ts';
import {projectItems} from './project.ts';
import {MINDMAP_MODEL,AUTOID} from './test-support.ts';
import {parseProfile} from './profile.ts';
import {contractOf,bedsOf} from './test-support.ts';
import {compileGrammar,commandIdentity} from './generated/command-grammar.ts';
import {selectCommandCatalog} from './subject.ts';
import {ROOT,policy,entries,catalog,grammar,fixture,cleanup} from '../testing/authority-scope.ts';
const good=['demo pool add one 10','demo pool add two 20',cleanup('no demo pool add two'),cleanup('no demo pool add one')];

test('prefix scopes authorize parsed commands without enumerating identities and require exact path segments',()=>{
 const value=fixture(good);assert.ok(checkCommandsKnown(value.input).every(row=>row.verdict==='support'),JSON.stringify(checkCommandsKnown(value.input)));
 const wrong=fixture(['demo poolish add one 10']);assert.ok(checkCommandsKnown(wrong.input).some(row=>row.verdict==='refute'&&row.statement.includes('交集')));
 const intersect=fixture(good);intersect.contract.effects.effect_0.commands=[commandIdentity(grammar,'demo pool add one 10')!];intersect.contract.contract_sha256=runtimeDigest(intersect.contract);assert.ok(checkCommandsKnown(intersect.input).some(row=>row.verdict==='refute'&&row.statement.includes('交集')));
 const empty=fixture(good);empty.contract.effects.effect_0.commands=[];empty.contract.contract_sha256=runtimeDigest(empty.contract);assert.ok(checkCommandsKnown(empty.input).some(row=>row.verdict==='refute'));
});

test('configuration requires same-device inverses in a cleanup suffix and in reverse order',()=>{
 for(const lines of [good.slice(0,2),[good[0],good[1],good[3],good[2]],[good[0],cleanup('no demo pool add different')],[cleanup('no demo pool add one'),good[0]]]){
  const value=fixture(lines);const result=checkCommandsKnown(value.input);assert.ok(result.some(row=>row.verdict==='refute'),JSON.stringify(result));
 }
 const observed=fixture(['show pool one']);assert.ok(checkCommandsKnown(observed.input).every(row=>row.verdict==='support'));
 const missing=fixture(good);(missing.input.subject.command_catalog as any).policy=undefined;assert.ok(checkCommandsKnown(missing.input).some(row=>row.verdict==='unknown'&&row.missing?.includes('产品命令')));
});

test('authored duplicate identities are counted, parameters may change, and missing occurrences remain obligations',()=>{
 const source=['demo pool add one 10','demo pool add one 10'];
 const missing=fixture(['demo pool add one 99',cleanup('no demo pool add one')],source);
 const result=checkCommandsKnown(missing.input);assert.ok(result.some(row=>row.verdict==='refute'&&row.statement.includes('可以改参数，不可以删命令')));
 assert.equal((result[0].data?.obligations as Array<{missing_count:number}>)[0].missing_count,1);
 const full=fixture(['demo pool add one 99','demo pool add one 98',cleanup('no demo pool add one'),cleanup('no demo pool add one')],source);
 assert.ok(checkCommandsKnown(full.input).every(row=>row.verdict==='support'),JSON.stringify(checkCommandsKnown(full.input)));
 const none=fixture([],source);none.data.steps=[{object:'widget-clock',method:'pause',args:['1'],keywords:{}}];assert.ok(checkCommandsKnown(none.input).some(row=>row.verdict==='refute'&&row.statement.includes('尚缺 2 次')));
});

test('selection includes source commands while inverse existence is proven by the parsed cleanup paths',()=>{
 const value=fixture(['demo pool add one 10']);
 const raw={context:{root:ROOT,command_policy:policy,groups:[{kind:'case-compile',contract:value.contract,profile:PROFILE_DOC,manifest:MANIFEST_DOC}]},item:{id:'case-1',group:'frozen',fields:{steps:[{text:'demo pool add omitted 20'}]}},slots:{plan:value.data}};
 // use the exact existing raw input adapter shape below
 const selected=selectCommandCatalog(raw) as {lines:string[]};
 assert.ok(selected.lines.includes('demo pool add omitted 20'));
 assert.ok(selected.lines.includes('demo pool add one 10'));
 assert.ok(!selected.lines.some(line=>line==='no demo pool add one 10'));
 assert.ok(selected.lines.length<=3,'prefetch grows with submitted/source operations, never the whole namespace');
});

test('capacity is derived from the frozen device type inventory, and excess ordinals refuse the whole compile',()=>{
 const profile=structuredClone(PROFILE_DOC);profile.seats[0].ordinal=2;
 const read=parseProfile(profile,contractOf(),bedsOf());assert.equal(read.ok,false);if(!read.ok)assert.ok(read.problems.some(problem=>problem.capacityExceeded&&problem.message.includes('框架取不到那台设备，整卷不跑')));
 const result=checkContractShape(subjectOf(goodData(),{profileDoc:profile}));assert.ok(result.some(row=>row.verdict==='refute'&&row.statement.includes('整卷不跑')));
});

test('a fixed-size scope contract accepts newly declared paths in a ten-thousand-command tree',()=>{
 const definitions=Array.from({length:10000},(_,index)=>{const source=entries[index%2===0?0:1];const words=[...(index%2===0?['demo','pool']:['no','demo','pool']),'op'+Math.floor(index/2)];return {...structuredClone(source),words,reference:'tree:'+ROOT+'/commands/'+words.join('/')};});
 for(const index of [0,2500,4999]){const selected=definitions.slice(index*2,index*2+2);const value=fixture(['demo pool op'+index+' one 10',cleanup('no demo pool op'+index+' one')]);value.input.subject.command_catalog={...structuredClone(catalog),entries:selected};const before=JSON.stringify(value.contract);assert.ok(checkCommandsKnown(value.input).every(row=>row.verdict==='support'),JSON.stringify(checkCommandsKnown(value.input)));assert.equal(JSON.stringify(value.contract),before);assert.equal(value.contract.effects.effect_0.commands,undefined);}
});

test('inverse signature arity is structural and an ambiguous arity needs an explicit product declaration',()=>{
 const valid=fixture(['demo pool add "one two" 10',cleanup('no demo pool add "one two"')]);delete (valid.input.subject.command_catalog as any).policy.inverse_rules[0].leading_parameters;
 assert.ok(checkCommandsKnown(valid.input).every(row=>row.verdict==='support'));
 const ambiguous=fixture(['demo pool add one 10',cleanup('no demo pool add one')]);const raw=ambiguous.input.subject.command_catalog as any;delete raw.policy.inverse_rules[0].leading_parameters;raw.entries[1].signatures.push({...raw.entries[1].signatures[0],reference:`src:${ROOT}/xml@1/x/commands/item[20]/arguments`,params:[]});
 assert.ok(checkCommandsKnown(ambiguous.input).some(row=>row.verdict==='unknown'&&row.missing?.includes('唯一前导')));
});

test('author commands cannot be moved into cleanup to erase their execution obligations',()=>{
 const value=fixture([cleanup('demo pool add one 10')],['demo pool add one 10']);
 assert.ok(checkCommandsKnown(value.input).some(row=>row.verdict==='refute'&&row.statement.includes('可以改参数，不可以删命令')));
});

test('an out-of-range device mapping refuses projection before any item of the document is admitted',()=>{
 const profile={...structuredClone(PROFILE_DOC),seats:[{...PROFILE_DOC.seats[0],ordinal:2}]};
 const projected=projectItems({inputs:[{slot:'subject',sha256:'f'.repeat(64),parser:'kityminder@1',model:MINDMAP_MODEL},{slot:'contract',parser:'json@1',model:CONTRACT_DOC},{slot:'profile',model:profile},{slot:'inventory',parser:'json@1',model:MANIFEST_DOC}],parameters:{autoid:AUTOID}}) as {error?:{message:string};items?:unknown[]};
 assert.ok(projected.error?.message.includes('框架取不到那台设备，整卷不跑'));assert.equal(projected.items?.length??0,0);
 const host={...structuredClone(PROFILE_DOC),hosts:[{...PROFILE_DOC.hosts[0],ordinal:1}]};
 assert.ok(checkContractShape(subjectOf(goodData(),{profileDoc:host})).some(row=>row.verdict==='refute'&&row.statement.includes('client')));
});

test('a quoted inverse identity argument does not turn into a same-spelled child command',()=>{
 const value=fixture(['demo pool add one 10',cleanup('no demo pool add "one"')]);
 const raw=value.input.subject.command_catalog as typeof catalog;
 raw.entries.push({words:['no','demo','pool','add','one'],reference:'tree:'+ROOT+'/commands/no/demo/pool/add/one',signatures:[{id:'1',reference:`src:${ROOT}/xml@1/x/commands/item[90]/arguments`,params:[]}]});
 assert.ok(checkCommandsKnown(value.input).every(row=>row.verdict==='support'),JSON.stringify(checkCommandsKnown(value.input)));
});
