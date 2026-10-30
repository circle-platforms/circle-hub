// A case index truncated only because some cases' facts are unknown (index-view unknown_entries/unknown_only): the dedup
// check never turns those cases into "no cases" or "no duplicate", keeps a visible duplicate refuted and quotes the view's
// notes. Every other truncation keeps the earlier handling.
import type {ExpectedQuoteIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import type {BoundInput} from '../../../../contracts/src/pack.ts';
import {IndexView} from '../../../../contracts/src/views.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createKnowledgeReader} from '../../../../hub/knowledge/api.ts';
import {startPostgres} from '../../../../hub/knowledge/test-support.ts';
import {world} from '../../../../hub/knowledge/testing/feeding-bounds-fixture.ts';
import {checkDuplicate} from './checks.ts';
import {buildCompactIndex,unknownEntriesOf} from './compact-index.ts';
import {expectedSources,INDEX_UNKNOWN_ENTRIES} from './expected.ts';
import {projectDefects} from './projection.ts';
import {SYNTHETIC_BOUND_MANUAL,SYNTHETIC_BUG_74001,SYNTHETIC_CATALOG,SYNTHETIC_INDEX_VIEW,UNKNOWN_COMMANDS_NOTE,UNKNOWN_ONLY_INDEX_VIEW,makeDuplicateDraft} from '../testing/fixtures.ts';

const path='/commands/show/health/detail';
const view=(changes:Record<string,unknown>={})=>({...structuredClone(SYNTHETIC_INDEX_VIEW),only:[path],cut_keys:[],...changes});
const drafts=()=>{const duplicate=makeDuplicateDraft(),distinct=makeDuplicateDraft();distinct.id='distinct';(distinct.expected[0].identity as ExpectedQuoteIdentity).span.offset++;return [duplicate,distinct];};
const dedup=(indexed:unknown)=>checkDuplicate({subject:{item:'synthetic',drafts:drafts(),indexed_cases:indexed},catalog:SYNTHETIC_CATALOG});
const NEW_FIELDS=['unknownEntries','unknownOnly','sourceNotes','invalidUnknown'];

test('the view reader takes the two optional fields as the contract writes them and nothing from the notes',()=>{
 assert.deepEqual(unknownEntriesOf(view()),{entries:null,only:false,invalid:false});
 assert.deepEqual(unknownEntriesOf(UNKNOWN_ONLY_INDEX_VIEW),{entries:2,only:true,invalid:false});
 assert.deepEqual(unknownEntriesOf(view({truncated:true,unknown_entries:3})),{entries:3,only:false,invalid:false});
 assert.deepEqual(unknownEntriesOf(view({truncated:true,unknown_entries:3,unknown_only:true,total_keys:2})),{entries:3,only:false,invalid:false});
 for(const malformed of [{truncated:true,unknown_entries:0},{truncated:true,unknown_entries:'2'},{truncated:true,unknown_entries:1.5},{truncated:false,unknown_entries:2},{truncated:true,unknown_only:true},{truncated:true,unknown_entries:2,unknown_only:false}])
  assert.equal(unknownEntriesOf(view(malformed)).invalid,true,JSON.stringify(malformed));
 // A note that reads like an unknown-entries note decides nothing.
 assert.deepEqual(unknownEntriesOf(view({truncated:true,notes:[UNKNOWN_COMMANDS_NOTE]})),{entries:null,only:false,invalid:false});
 // Every view the Hub binds satisfies the public contract.
 assert.equal(IndexView.safeParse(UNKNOWN_ONLY_INDEX_VIEW).success,true);
});

test('complete view: no new compact fields, a different structure is supported and the same structure refuted',()=>{
 const compact=buildCompactIndex(view());
 for(const field of NEW_FIELDS)assert.equal(Object.hasOwn(compact,field),false,field);
 assert.equal(compact.complete,true);
 const [duplicate,distinct]=dedup(compact);
 assert.equal(duplicate.verdict,'refute');assert.equal(duplicate.code,'defect-to-case.duplicate_case');
 assert.equal(distinct.verdict,'support');assert.equal(Object.hasOwn(distinct.data??{},'unknown_entries'),false);
});

test('unknown-only view: a visible duplicate is refuted, no duplicate is unknown with the count, the view notes and the next action',()=>{
 const compact=buildCompactIndex(UNKNOWN_ONLY_INDEX_VIEW);
 assert.equal(compact.complete,false);assert.equal(compact.sourceTruncated,true);
 assert.equal(compact.unknownEntries,2);assert.equal(compact.unknownOnly,true);assert.deepEqual(compact.sourceNotes,[UNKNOWN_COMMANDS_NOTE]);
 assert.ok(compact.notes.some(note=>note.includes('只因 2 个用例缺查询所需的事实而截断')&&note.includes('不能当作没有用例')));
 assert.ok(!compact.notes.includes('源用例索引已被截断'));
 // The narrowed view the engine injects and the compact form the projection froze give the same outcomes.
 for(const indexed of [UNKNOWN_ONLY_INDEX_VIEW,compact]){
  const [duplicate,distinct]=dedup(indexed);
  assert.equal(duplicate.verdict,'refute');assert.equal(duplicate.code,'defect-to-case.duplicate_case');
  assert.equal(distinct.verdict,'unknown');assert.equal(distinct.reason,'integrity_unproven');
  assert.match(distinct.statement,/源索引有 2 个用例缺本次查询所需的事实/);
  assert.match(distinct.statement,/不能当作没有用例或没有重复/);
  assert.ok(distinct.statement.includes(`视图说明「${UNKNOWN_COMMANDS_NOTE}」`));
  assert.match(distinct.statement,/补齐这些用例的事实后以新输入重开运行/);
  assert.doesNotMatch(distinct.statement,/源索引截断；下一步同根补完整范围/);
  assert.match(distinct.missing!,/同一修订重读补不出这些事实/);
  assert.equal(distinct.data?.unknown_entries,2);
 }
});

test('unknown-only view without the requested key: the absent key is unknown, never an empty result',()=>{
 const [,distinct]=dedup(view({keys:{},entries:{},total_keys:0,total_entries:0,truncated:true,unknown_entries:4,unknown_only:true,notes:[UNKNOWN_COMMANDS_NOTE]}));
 assert.equal(distinct.verdict,'unknown');
 assert.match(distinct.statement,/请求的键 \/commands\/show\/health\/detail 在已列出的用例里没有条目/);
 assert.doesNotMatch(distinct.statement,/缺少请求的键/);
});

for(const [name,changes] of [
 ['unknown entries next to other truncation (no unknown_only)',{truncated:true,unknown_entries:3}],
 ['truncated with neither field',{truncated:true}],
 // unknown_only says nothing else was cut: lists short of the counts, or cut keys, contradict it.
 ['unknown_only whose lists fall short of total_entries',{truncated:true,unknown_entries:2,unknown_only:true,total_entries:5}],
 ['unknown_only next to cut keys',{truncated:true,unknown_entries:2,unknown_only:true,cut_keys:[path]}],
] as const)test(name+' keeps the earlier truncation handling',()=>{
 const compact=buildCompactIndex(view(changes));
 assert.equal(Object.hasOwn(compact,'unknownOnly'),false);assert.equal(Object.hasOwn(compact,'sourceNotes'),false);
 assert.ok(compact.notes.includes('源用例索引已被截断'));
 const [duplicate,distinct]=dedup(compact);
 assert.equal(duplicate.verdict,'refute');
 assert.equal(distinct.verdict,'unknown');assert.equal(distinct.reason,'integrity_unproven');
 assert.match(distinct.statement,/源索引截断；下一步同根补完整范围/);
 assert.match(distinct.missing!,/截断时按同一根补读/);
 assert.equal(Object.hasOwn(distinct.data??{},'unknown_entries'),false);
});

test('malformed unknown-entry fields prove no completeness, and a visible duplicate is still refuted',()=>{
 for(const changes of [{truncated:false,unknown_entries:2},{truncated:true,unknown_only:true},{truncated:true,unknown_entries:0}]){
  const compact=buildCompactIndex(view(changes));
  assert.equal(compact.invalidUnknown,true,JSON.stringify(changes));assert.equal(compact.complete,false);
  const [duplicate,distinct]=dedup(compact);
  assert.equal(duplicate.verdict,'refute');
  assert.equal(distinct.verdict,'unknown');assert.match(distinct.statement,/unknown_entries 或 unknown_only 字段形状无效或与 truncated 矛盾/);
 }
});

const boundIndex=(model:unknown):BoundInput=>({slot:'indexed_cases',external:'knowledge:index:apv:Rel_APV_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure',sha256:'d'.repeat(64),media_type:'application/json',parser:'json@1',model,meta:null});
const bug:BoundInput={slot:'defects',external:'plm:bug:74001',sha256:'e'.repeat(64),media_type:'application/json',parser:'json@1',model:SYNTHETIC_BUG_74001,meta:null};
const context={product:'apv',names:['APV'],line:'10.6.1',build:'Rel_APV_10_6_1_57',root:'1'.repeat(64),parameters:{},groups:[]};

test('start_run gap: an unknown-only bound index is disclosed with its count, the view notes and the next action',()=>{
 const items=(model:unknown)=>{const projected=projectDefects({inputs:[SYNTHETIC_BOUND_MANUAL,bug,boundIndex(model)],parameters:{},context});assert.ok(!('error' in projected));return projected.items;};
 const gapsOf=(model:unknown)=>{const out=expectedSources({inputs:[SYNTHETIC_BOUND_MANUAL,bug,boundIndex(model)],parameters:{},context,items:items(model)});assert.ok(!('error' in out));return out.warnings;};
 const [gap,...rest]=gapsOf(UNKNOWN_ONLY_INDEX_VIEW);
 assert.equal(rest.length,0);assert.equal(gap.code,INDEX_UNKNOWN_ENTRIES);assert.deepEqual(gap.data,{unknown_entries:2});
 assert.match(gap.message,/只因 2 个用例缺查询所需的事实而截断/);assert.match(gap.message,/不是没有用例/);assert.match(gap.message,/没查出重复的草稿记未知/);
 assert.ok(gap.message.includes(`视图说明「${UNKNOWN_COMMANDS_NOTE}」`));assert.match(gap.message,/下一步：按视图说明补齐/);
 for(const model of [SYNTHETIC_INDEX_VIEW,view({truncated:true,unknown_entries:3}),view({truncated:true})])assert.deepEqual(gapsOf(model),[],JSON.stringify(model.truncated));
 // The compact index frozen by the projection keeps what the legacy check path needs to say the same.
 const projected=projectDefects({inputs:[SYNTHETIC_BOUND_MANUAL,bug,boundIndex(UNKNOWN_ONLY_INDEX_VIEW)],parameters:{},context});
 assert.ok(!('error' in projected));
 const compact=(projected.groups![0] as {indexed_cases:ReturnType<typeof buildCompactIndex>}).indexed_cases;
 assert.equal(compact.unknownOnly,true);assert.deepEqual(compact.sourceNotes,[UNKNOWN_COMMANDS_NOTE]);
});

test('the real knowledge views: cases whose steps are not complete commands keep "no duplicate" unknown with their count',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());
 const w=await world(pg,false,undefined,'<commands><menu name="system"><item name="status"><arguments/></item></menu></commands>');t.after(()=>w.close());
 await w.knowledge.feeding!.observeSource(w.user,w.document.body.sha256,w.scope);
 const read=await createKnowledgeReader(w.knowledge).read(`knowledge:index:apv:${w.name}?kind=case&key=commands&only=%2Fcommands%2Fsystem%2Fshow&fields=commands,document,node,title,negative,case_structure`,{principal:w.user,run:null,purpose:'Synthetic unknown command entries'});
 assert.ok(read.ok,read.ok?'':read.reason);
 const original=read.artifacts.find(row=>row.name==='original');assert.ok(original);
 const source=await w.kit.artifacts.source(w.user,original.artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);
 const indexed=IndexView.parse(JSON.parse(new TextDecoder().decode(source.bytes)));
 assert.equal(indexed.unknown_only,true);assert.equal(indexed.unknown_entries,40);assert.deepEqual(indexed.keys,{});
 const signature='src:'+'b'.repeat(64)+'/xml@1/x/system/show';
 const draft=makeDuplicateDraft();draft.id='system-show';draft.steps=[{command:'system show',identity:{tree_root:'b'.repeat(64),path:'/commands/system/show',signature,parameters:[]}}];
 const catalog=[{words:['system','show'],reference:'tree:'+'a'.repeat(64)+'/commands/system/show',signatures:[{id:'show',reference:signature,params:[]}]}];
 const [outcome]=checkDuplicate({subject:{indexed_cases:indexed,drafts:[draft]},catalog});
 assert.equal(outcome.verdict,'unknown');assert.equal(outcome.reason,'integrity_unproven');
 assert.match(outcome.statement,/源索引有 40 个用例缺本次查询所需的事实/);
 assert.match(outcome.statement,/请求的键 \/commands\/system\/show 在已列出的用例里没有条目/);
 for(const note of indexed.notes)assert.ok(outcome.statement.includes(note),note);
 assert.equal(outcome.data?.unknown_entries,40);
});
