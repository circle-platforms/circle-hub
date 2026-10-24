import type {CommandIdentity,ExpectedQuoteIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
// Coverage and equality are independent: a visible complete duplicate is provable even in an incomplete view.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkDuplicate} from './checks.ts';
import {buildCompactIndex,MAX_INDEX_PER_KEY,onlyOfExternal} from './compact-index.ts';
import {SYNTHETIC_CATALOG,SYNTHETIC_INDEX_VIEW,makeDuplicateDraft} from '../testing/fixtures.ts';
const path='/commands/show/health/detail';
function run(changes:Record<string,unknown>={},duplicate=false,external:string|null=null){
 const draft=makeDuplicateDraft();draft.id=duplicate?'duplicate':'distinct';if(!duplicate)(draft.expected[0].identity as ExpectedQuoteIdentity).span.offset++;
 const view={...structuredClone(SYNTHETIC_INDEX_VIEW),only:[path],cut_keys:[],...changes};
 const compact=buildCompactIndex(view,64*1024*1024,external);
 return {compact,out:checkDuplicate({subject:{item:'synthetic',drafts:[draft],indexed_cases:compact},catalog:SYNTHETIC_CATALOG})[0]};
}
test('URI parser reads exact closed command keys and strips revisions',()=>{
 assert.deepEqual(onlyOfExternal('knowledge:index:p:b?only=%2Fcommands%2Fshow%2Fhealth%2Fdetail,reboot@'+'a'.repeat(64)),[path,'reboot']);assert.equal(onlyOfExternal(null),null);
});
test('complete scope supports a different structure and refutes the same structure regardless of title',()=>{assert.equal(run().out.verdict,'support');assert.equal(run({},true).out.verdict,'refute');});
const incomplete:[string,Record<string,unknown>,RegExp][]=[
 ['outside only',{only:['/commands/widget/health/interval']},/草稿命令.*only/],
 ['skipped',{skipped:3},/3 份文档.*新根/],
 ['truncated',{truncated:true},/截断/],
 ['cut',{cut_keys:[path]},/每键上限.*集成者/],
 ['malformed only',{only:null},/only.*cut_keys.*字段形状无效/],
 ['malformed cut keys',{cut_keys:[123]},/字段形状无效/],
 ['missing requested bucket',{keys:{},entries:{},truncated:true},/缺少请求的键/],
 ['missing author structure',{entries:{x:{reference:'tree:'+'a'.repeat(64)+'/case/x',data:{document:'doc',node:'n',commands:[path]}}}},/缺完整作者结构声明/],
 ['missing commands',{entries:{x:{...Object.values(SYNTHETIC_INDEX_VIEW.entries)[0],data:{...Object.values(SYNTHETIC_INDEX_VIEW.entries)[0].data,commands:undefined}}}},/commands 字段/],
 ['empty command list',{entries:{x:{...Object.values(SYNTHETIC_INDEX_VIEW.entries)[0],data:{...Object.values(SYNTHETIC_INDEX_VIEW.entries)[0].data,commands:[]}}}},/未归位/],
];
for(const [name,changes,message] of incomplete)test(name+' preserves unknown facts and next action',()=>{const {out}=run(changes);assert.equal(out.verdict,'unknown');assert.equal(out.reason,'integrity_unproven');assert.match(out.statement,message);assert.match(out.missing!,/下一步/);});
for(const changes of [{skipped:3},{truncated:true},{cut_keys:[path]},{only:['other']}])test('visible duplicate survives incomplete metadata '+JSON.stringify(changes),()=>assert.equal(run(changes,true).out.verdict,'refute'));
test('view only takes precedence over URI',()=>{const {compact,out}=run({},false,'knowledge:index:p:b?only=other');assert.deepEqual(compact.only,[path]);assert.equal(out.verdict,'support');});
test('legacy cap inference and explicit empty cut keys remain distinct',()=>{
 const digest=Object.keys(SYNTHETIC_INDEX_VIEW.entries)[0],keys={[path]:Array(MAX_INDEX_PER_KEY).fill(digest)};
 const view={...structuredClone(SYNTHETIC_INDEX_VIEW),keys,only:[path]};const inferred=buildCompactIndex(view);assert.deepEqual(inferred.cappedKeys,[path]);
 const explicit=run({keys,cut_keys:[]});assert.equal(explicit.out.verdict,'support');assert.deepEqual(explicit.compact.cappedKeys,[]);
});
test('complete source may omit a genuinely empty requested key',()=>{assert.equal(run({entries:{},keys:{}}).out.verdict,'support');});
test('source skipping and outside scope disclose independent actions',()=>{const {out}=run({skipped:3,only:['other']});assert.match(out.statement,/3 份文档.*新根/);assert.match(out.statement,/草稿命令.*only/);});
test('one duplicate does not suppress another draft whose coverage is incomplete',()=>{
 const duplicate=makeDuplicateDraft(),other=makeDuplicateDraft();other.id='other';(other.expected[0].identity as ExpectedQuoteIdentity).span.offset++;
 const compact=buildCompactIndex({...SYNTHETIC_INDEX_VIEW,truncated:true,only:[path],cut_keys:[]});
 const out=checkDuplicate({subject:{drafts:[duplicate,other],indexed_cases:compact},catalog:SYNTHETIC_CATALOG});assert.equal(out[0].verdict,'refute');assert.equal(out[1].verdict,'unknown');assert.equal(out[1].data?.draft_id,'other');
});
