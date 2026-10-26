// Real composition storage and read boundaries, with synthetic manual bytes only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extraProducer,makeWorld,startPostgres} from '../../../hub/knowledge/test-support.ts';
import {markdown} from './testing/test-support.ts';
import {produceManualEntries} from './functions/manual.ts';

const declared = (section: string[], conditions: Record<string, unknown>) => ['```famx-applicability@1', JSON.stringify({schema:'famx-applicability@1', scope:{section,descendants:true}, conditions}), '```'].join('\n')+'\n\n';

for(const conflict of [false,true])test(`composition preserves verified applicability origins and read status (conflict=${conflict})`,async t=>{
  const source='# Outer\n\n'+declared(['Outer'],{components:{with:['Card-A']},memory:{minimum:{bytes:8*1024**3,inclusive:true},raw:'8GiB'}})+(conflict?declared(['Outer'],{components:{with:['Card-B']}}):'')+'## Child\n\n普通正文。\n';
  const output=produceManualEntries(markdown(source),null,{components:['Card-A','Card-B']});
  const pg=await startPostgres();t.after(()=>pg.stop());
  const w=await makeWorld(pg,{knowledge:{limits:{inlineRows:1}},pack:{declaration:{catalogs:[],producers:[extraProducer('declared',output,{manual:{external:'store:doc:applicability'}})]}}});t.after(()=>w.close());
  w.external.set('store:doc:applicability',{bytes:source,mediaType:'text/markdown'});
  const made=await w.knowledge.produceTree({product:w.product,build:{name:'Synthetic_10_8_1',family:'ACME',line:'10.8',base:'Synthetic_10_8_1',platform:null,built_at:null,released_at:null,sources:{},root:null}});
  assert.ok(made.ok,JSON.stringify(made));
  const nodes=await w.knowledge.getNodes({root:made.root!,paths:[output.entries.find(entry=>entry.statement==='普通正文。')!.path!],depth:0},w.user);
  assert.ok(nodes?.nodes.length,JSON.stringify(nodes));
  const node=nodes.nodes[0]!;
  const row=node.entries.find(entry=>entry.statement==='普通正文。')!;assert.ok(row,JSON.stringify(node));
  const read=await w.knowledge.treeReader().read(made.root!,node.path,row.entry,{user:w.user.id,role:w.user.role});assert.ok(read);
  const data=read.data as any;assert.ok(data.applicability_sources.length);
  assert.ok(data.applicability_sources.every((origin:any)=>origin.fragment.startsWith('src:')&&origin.section.length));
  if(conflict){assert.equal(data.applicability?.components,undefined);assert.equal(data.applicability_sources.filter((origin:any)=>origin.conflict).length,2);assert.ok(JSON.stringify(read.validity).includes('contradicted'));assert.ok(JSON.stringify(node).includes('章节开头冲突'));}
  else {assert.ok(JSON.stringify(node).includes('继承自章节开头'));assert.ok(JSON.stringify(read.validity).includes('缺目标上的部件观察'));}
});

test('overridden outer conflicts remain verified composition provenance after warning truncation',async t=>{
  const source='# Outer\n\n'+declared(['Outer'],{components:{with:['Card-A']}})+declared(['Outer'],{components:{with:['Card-B']}})+'## Inner\n\n'+declared(['Outer','Inner'],{components:{with:['Card-C']}})+'普通正文。\n';
  const output=produceManualEntries(markdown(source),null,{components:['Card-A','Card-B','Card-C']});
  output.warnings.unshift(...Array.from({length:200},()=> '合成报告预算占位'));
  const pg=await startPostgres();t.after(()=>pg.stop());
  const w=await makeWorld(pg,{knowledge:{limits:{inlineRows:1}},pack:{declaration:{catalogs:[],producers:[extraProducer('declared',output,{manual:{external:'store:doc:override'}})]}}});t.after(()=>w.close());
  w.external.set('store:doc:override',{bytes:source,mediaType:'text/markdown'});
  const made=await w.knowledge.produceTree({product:w.product,build:{name:'Synthetic_10_8_1',family:'ACME',line:'10.8',base:'Synthetic_10_8_1',platform:null,built_at:null,released_at:null,sources:{},root:null}});assert.ok(made.ok,JSON.stringify(made));
  assert.ok(!made.warnings.some(warning=>warning.includes('内外层不同')));
  const path=output.entries.find(entry=>entry.statement==='普通正文。')!.path!;
  const node=(await w.knowledge.getNodes({root:made.root!,paths:[path],depth:0},w.user))!.nodes[0]!;
  const entry=node.entries.find(row=>row.statement==='普通正文。')!;
  const read=await w.knowledge.treeReader().read(made.root!,path,entry.entry,{user:w.user.id,role:w.user.role});assert.ok(read);
  const data=read.data as any;
  assert.deepEqual(data.applicability.components,{with:['Card-C']});
  const sources=data.applicability_sources.filter((origin:any)=>origin.field==='components');
  assert.equal(sources.length,3);assert.equal(sources.filter((origin:any)=>origin.superseded&&origin.conflict).length,2);
  assert.ok(sources.every((origin:any)=>origin.fragment.startsWith('src:')));
  assert.ok(!JSON.stringify(read.validity).includes('contradicted'));
  assert.equal(entry.applicability, '部件 装有 Card-C', 'Inner has its own explicit declaration');
  assert.ok(!entry.applicability.includes('、'),entry.applicability);
  assert.ok(sources.some((origin:any) => !origin.superseded && JSON.stringify(origin.section) === JSON.stringify(['Outer','Inner'])));
});
