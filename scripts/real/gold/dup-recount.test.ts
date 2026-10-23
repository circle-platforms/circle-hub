import assert from 'node:assert/strict';
import { test } from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { recountDuplicates, renderRecount, main } from './dup-recount.ts';
const xml='<commands><menu name="widget"><item name="a"/><item name="b"/></menu></commands>';
const draft={items:[{item:'i',slots:{cases:[{data:{title:'Ａ   CASE',negative:false,steps:[{command:'widget a\nwidget b'}]}}]}}]};
const entry=(digest:string,doc:string,title='a case',negative=false)=>({entry:digest.repeat(64),kind:'case',statement:'',reference:`tree:${'a'.repeat(64)}/commands/widget/a@${digest.repeat(64)}`,data:{document:doc,node:'n',title,negative,commands:['/commands/widget/a','widget b']}});
const view=(raw:any)=>{const entries=Object.fromEntries(Object.values(raw).map((e:any)=>[e.entry,e]));return ({schema:'index-view@1',product:'Demo',build:{build:'Demo_1',root:'a'.repeat(64)},kind:'case',key:'commands',keys:{'widget a':Object.keys(entries),'widget b':Object.keys(entries)},entries,total_keys:2,total_entries:Object.keys(entries).length,truncated:false,skipped:0,notes:[]});};
const hub=(doc?:string)=>({partitions:{delivered:[{item:'i',requirements:[{requirement:'not_duplicate',status:'satisfied',claims:doc?[{statement:{code:'defect-to-case.duplicate_case',verdict:'refute',text:'起草用例“Ａ   CASE”与已索引用例重复',data:{duplicate_of:{document:doc,node:'n'}}}}]:[]}]}]}});
test('two command entries count one case and retain the three filtering stages',()=>{
  const report=recountDuplicates([view({a:entry('a','d1'),b:entry('b','d1'),c:entry('c','d2','different'),d:entry('d','d3','a case',true)})],draft,xml,hub('d1'));
  assert.deepEqual([report.details[0].sameCommands,report.details[0].sameNegative,report.details[0].sameTitle],[3,2,1]);assert.equal(report.details[0].titleEqual,true);assert.equal(report.passed,true);assert.equal(report.details[0].gap,undefined);assert.equal(report.expectedBranchAffected,1);assert.match(renderRecount(report),/没法重算.*requirements.json:70/);
  assert.ok(!renderRecount(report).includes('Ａ   CASE'));
});
for(const mode of ['only','cut_keys','truncated'])test(`incomplete ${mode} is unknown`,()=>{
  const v:any=view({a:entry('a','d1')});if(mode==='only')v.only=['widget absent'];if(mode==='cut_keys')v.cut_keys=['widget a','widget b'];if(mode==='truncated')v.truncated=true;
  const r=recountDuplicates([v],draft,xml,hub());assert.equal(r.unknown,1);assert.equal(r.details[0].sameTitle,null);assert.equal(r.details[0].reason,'integrity_unproven');
});
test('views merge by entry digest and order cannot change the answer',()=>{
  const one=view({a:entry('a','d1')}),two=view({a:entry('a','d1'),b:entry('b','d2','different')});
  assert.deepEqual(recountDuplicates([one,two],draft,xml,hub('d1')),recountDuplicates([two,one],draft,xml,hub('d1')));
  assert.equal(recountDuplicates([one],draft,xml,hub('d1')).equal,1);
  assert.equal(recountDuplicates([one],draft,xml,hub('d2')).different,1);
});
test('skipped documents are disclosed, and missing Hub evidence is unknown',()=>{
  const v=view({a:entry('a','d1')});v.skipped=2;
  const report=recountDuplicates([v],draft,xml,{});assert.equal(report.skipped,2);assert.equal(report.unknown,1);assert.match(renderRecount(report),/只覆盖读到的文档/);
});
test('the report attributes case command ownership to the supplied Hub index view',()=>{
  const report=recountDuplicates([view({a:entry('a','d1')})],draft,xml,hub('d1'));
  assert.equal(report.commandOwnership,'hub_index_input');
  assert.match(renderRecount(report),/命令归属取自 Hub.*index-view@1/);
});
for(const mode of ['pending','unknown_claim'])test(`a decided draft differs from undecided Hub output: ${mode}`,()=>{
  const result=hub(),requirement=result.partitions.delivered[0].requirements[0];
  if(mode==='pending')requirement.status='pending';
  else (requirement.claims as any[]).push({statement:{verdict:'unknown',reason:'missing_input',text:'起草用例“Ａ   CASE”未核对'}});
  const report=recountDuplicates([view({})],draft,xml,result);
  assert.equal(report.different,1);assert.equal(report.unknown,0);assert.equal(report.passed,false);
  assert.equal(report.details[0].hubOutputMissing,true);
});

test('a missing duplicate requirement is a Hub mismatch when the independent inputs are complete',()=>{
  const report=recountDuplicates([view({})],draft,xml,{});
  assert.equal(report.different,1);assert.equal(report.unknown,0);assert.equal(report.details[0].gap,undefined);
});

test('recount diagnostics identify the mixed view without printing original identities',t=>{
  const dir=mkdtempSync(join(tmpdir(),'d2c-index-diagnostic-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let errors='';t.mock.method(process.stderr,'write',(value:any)=>{errors+=String(value);return true;});
  const one=view({}),two={...view({}),product:'PRIVATE_PRODUCT'};
  for(const [name,value] of Object.entries({one,two,draft,result:hub()}))writeFileSync(join(dir,name),JSON.stringify(value));
  writeFileSync(join(dir,'commands'),xml);
  assert.equal(main(['--index',join(dir,'one'),'--index',join(dir,'two'),'--drafts',join(dir,'draft'),'--commands',join(dir,'commands'),'--result',join(dir,'result')]),2);
  assert.match(errors,/index view 2: mixed identity/);assert.doesNotMatch(errors,/PRIVATE_PRODUCT/);
});
