import {kityminderParser} from "../../../../hub/testing/parsers.ts";
// Synthetic source bytes and accepted-result-shaped records; expected grouping is computed independently here.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {projectItems} from '../../case-review/api.ts';
import {fixtureBytes,largeDocument,compactText} from '../../../../tests/fixtures/mindmaps/index.ts';
import {reviewTables as rawReviewTables,escapeTableText,caseText,type TableBlock,type TableInput} from './tables.ts';
function reviewTables(value:TableInput){const output=rawReviewTables(value);assert.ok(!('error'in output),JSON.stringify(output));return output;}
const SHA='a'.repeat(64);
const parse=(value:unknown)=>kityminderParser.parse(Buffer.from(JSON.stringify(value))).model;
const node=(id:string,text:string,children:unknown[]=[],data:Record<string,unknown>={})=>({data:{id,text,...data},children});
const small=()=>parse(nodeDocument());
function nodeDocument(){return {root:node('root','合成文档',[
  node('upper','分组',[node('sub','子项',[node('c1','用例甲',[node('e1','期望甲'),node('p1','准备',[],{priority:3})],{resource:['Functional'],priority:2}),node('c2','用例乙',[node('e2','期望乙')],{resource:['Negative'],priority:2})])]),
  node('other','另一子项',[node('c3','用例丙',[node('e3','期望丙')],{resource:['Functional'],priority:2})]),
  node('direct','根下用例',[node('ed','成功')],{resource:['Functional'],priority:2}),
])};}
const ref=(id:string)=>'src:'+SHA+'/kityminder@1/n/'+id;
const claim=(code:string,text:string,rank='minor',location?:string)=>({
  statement:{code,text,rank,data:{probe:'coverage_gap'}},qualifier:{nature:'judgment'},warrant:{producer:'model',id:'synthetic-verifier@1'},
  grounds:[],...(location?{resolutions:[{pointer:'/items/0/slots/verification/0/location',references:[location]}]}:{}),
});
function block(ids:string[],claims:Record<string,unknown>[][]=[],record='1'):TableBlock{
  return {record:record.repeat(64),result:{
    partitions:{delivered:ids.map((id,index)=>({item:id,label:id,location:ref(id),requirements:[{requirement:'verification',claims:claims[index]??[]}]}))},
    cross_item:[{...claim('PARTIAL','结论','P5'),requirement:'final'}],
  }};
}
const input=(model=small(),blocks=[block(['c1','c2','c3','direct'])]):TableInput=>({model,digest:SHA,blocks,overall:{verdict:'PARTIAL',level:'P5'},preconditionPriority:3});
const readJson=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));

test('review-150 grouping, rows and nested cases follow source document order independently',()=>{
  const model=kityminderParser.parse(fixtureBytes('review-150.km.json')).model;
  const projected=projectItems({documents:[{documentId:'synthetic',model}],parameters:{caseRule:'marked'},limits:{outputBytes:Infinity}});
  assert.ok('items'in projected);
  const selected=new Set(projected.items.map(item=>item.location.selector)),caseIndexes=model.nodes.flatMap((n,i)=>selected.has(n.selector)?[i]:[]);
  const groups=new Map<number,number[]>();
  for(const index of caseIndexes){
    let outer=index;
    for(let p=model.nodes[index].parent;p!==null;p=model.nodes[p].parent)if(caseIndexes.includes(p))outer=p;
    let group=model.nodes[outer].parent??0;
    while(group!==0&&caseIndexes.some(c=>{for(let p=model.nodes[group].parent;p!==null;p=model.nodes[p].parent)if(p===c)return true;return false;}))group=model.nodes[group].parent??0;
    groups.set(group,[...(groups.get(group)??[]),index]);
  }
  const all=block([],[]);all.result.partitions={delivered:caseIndexes.map(i=>({item:model.nodes[i].selector,label:model.nodes[i].text,location:'src:'+SHA+'/kityminder@1/'+model.nodes[i].selector,requirements:[]}))};
  const out=reviewTables({...input(model,[all]),foldEmpty:false});
  const expected=[...groups].sort(([a],[b])=>a-b);
  assert.deepEqual(out.counts.subitems.map(group=>[group.selector,group.counts.cases]),expected.map(([i,rows])=>[model.nodes[i].selector,rows.length]));
  assert.equal(out.counts.total.cases,caseIndexes.length);
  for(const name of ['IPv4','IPv6'])assert.equal(out.counts.subitems.filter(group=>group.name.endsWith(name)).length,1);
  const nested=model.nodes.findIndex(n=>n.text==='恢复一台后端后');assert.ok(nested>=0);
  let ancestor=model.nodes[nested].parent;while(ancestor!==null&&!caseIndexes.includes(ancestor))ancestor=model.nodes[ancestor].parent;
  assert.notEqual(ancestor,null);assert.ok(!caseText(model,ancestor!,new Set(caseIndexes),3).includes('恢复一台后端后'));
  assert.equal((out.markdown.match(/^\| \d+ \|/gm)??[]).length,caseIndexes.length);
});

test('cell and heading escaping is reversible and every row has five cells',()=>{
  const raw='\\'+String.fromCharCode(96)+'*_[]<|~&↵｜😀\n甲\r\n乙\r丙';
  const model=parse({root:node('root',raw,[node('case',raw,[node('pre',raw,[],{priority:3}),node('step',raw,[node('leaf',raw)])],{resource:[raw],priority:2})])});
  const b=block(['case'],[[claim('verified','原样说明')]]),out=reviewTables(input(model,[b]));
  assert.ok(out.markdown.includes('（直接在文档根下）'));
  const row=out.markdown.split('\n').find(line=>line.startsWith('| 1 |'))!;
  assert.equal(row.split(/(?<!\\)(?:\\\\)*\|/).length-2,5);
  const expected=raw+'；标签：'+raw+'；前置：'+raw+'；步骤 1：'+raw+' → '+raw;
  assert.ok(row.includes(escapeTableText(expected)));
  assert.equal(unescape(escapeTableText(raw)),raw.replace(/\r\n|\r/g,'\n'));
  assert.ok(!caseText(model,1,new Set([1]),null).includes('；前置：'));
});
function unescape(text:string){return text.replace(/\\([\s\S])|↵/g,(_all,escaped:string|undefined)=>escaped??'\n');}
test('seeded escape roundtrips preserve all characters apart from newline normalization',()=>{
  const alphabet=[...('\\'+String.fromCharCode(96)+'*_[]<|~&↵｜😀abc甲\n\r')];let state=17;
  for(let sample=0;sample<300;sample++){
    let raw='';for(let i=0;i<70;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;raw+=alphabet[state%alphabet.length];}
    assert.equal(unescape(escapeTableText(raw)),raw.replace(/\r\n|\r/g,'\n'));
  }
});

test('finding and suggestion locations route to rows, subitems or cross-subitems without depending on block order',()=>{
  const a=block(['c1'],[[claim('verified','在本用例','minor',ref('c1')),claim('partial','在期望叶子','major',ref('e1')+'/@text:0-3'),claim('new_finding','在子项','minor',ref('sub')),claim('new_finding','在上层','minor',ref('upper')),claim('new_finding','在根','major',ref('root')),claim('verified','转挂乙','minor',ref('c2')),claim('verified','缺位置按条目'),claim('refuted','推翻的不显示')]],'1');
  const b=block(['c2','c3','direct'],[],'2');
  const suggestions=[
    {...claim('suggestion','补：甲；因为：缺口；期望：成功'),grounds:[ref('c1')]},
    {...claim('suggestion','补：子项；因为：缺口；期望：成功'),grounds:[ref('sub')]},
    {...claim('suggestion','补：跨表；因为：缺口；期望：成功'),grounds:[ref('c1'),ref('c3')]},
    {...claim('suggestion','补：未落点；因为：缺口；期望：成功'),grounds:['tree:'+'b'.repeat(64)+'/']},
  ];a.result.cross_item.push(...suggestions);
  const out=reviewTables(input(small(),[a,b]));
  assert.deepEqual(out,reviewTables(input(small(),[b,a])));assert.deepEqual(out,reviewTables(input(small(),[a,b])));
  assert.equal(out.counts.total.findings,7);assert.equal(out.counts.total.refuted,1);assert.equal(out.counts.total.suggestions,4);
  assert.deepEqual(out.counts.total.severity,{critical:0,major:2,minor:5});
  assert.ok(!out.markdown.includes('推翻的不显示'));
  const row=out.markdown.split('\n').find(line=>line.startsWith('| 2 | 用例乙'))!;assert.ok(row.includes('转挂乙'));
  assert.match(out.markdown,/子项上的发现：.*在子项/);assert.match(out.markdown,/子项上的建议：.*补：子项/);
  assert.match(out.markdown,/发现：.*在根.*在上层/);assert.match(out.markdown,/没有写落点/);
});

test('empty subitems fold but suggestions and source-attributed Hub facts remain visible',()=>{
  const b=block(['c1','c2','c3','direct']);
  const out=reviewTables(input(small(),[b]));
  assert.equal((out.markdown.match(/—— 用例 \d+ 个，无发现/g)??[]).length,3);
  b.result.partitions.delivered[0].requirements[0].layers=[{layer:'static',terminal:'violation',attribution:'author_input'}];
  b.result.partitions.delivered[0].requirements[0].claims.push({
    qualifier:{nature:'fact',source_role:'subject'},warrant:{producer:'function',id:'structure@1'},
    statement:{verdict:'refute',code:'core.structure.required_empty',text:'已核对：期望为空'},
  });
  const checked=reviewTables(input(small(),[b]));assert.match(checked.markdown,/\| Hub 核对 \|/);assert.match(checked.markdown,/已核对：期望为空/);assert.equal(checked.counts.total.hubChecks,1);
  b.result.cross_item.push({...claim('suggestion','补：丙；因为：缺口；期望：成功'),grounds:[ref('c3')]});
  assert.ok(reviewTables(input(small(),[b])).markdown.includes('| 1 | 用例丙'));
});

test('500 source cases over five blocks remain below eight MiB',()=>{
  const model=kityminderParser.parse(Buffer.from(compactText(largeDocument()))).model;
  const projected=projectItems({documents:[{documentId:'large',model}],parameters:{caseRule:'marked'},limits:{outputBytes:Infinity}});
  assert.ok('items'in projected);assert.ok(projected.items.length>=500);
  const blocks=Array.from({length:5},(_,index)=>{const b=block([],[],String(index+1));b.result.partitions={delivered:projected.items.slice(index*100,index*100+100).map(item=>({item:item.id,label:item.label,location:'src:'+SHA+'/kityminder@1/'+item.location.selector,requirements:[]}))};return b;});
  const out=reviewTables({...input(model,blocks),foldEmpty:false});assert.equal(out.counts.total.cases,500);assert.ok(Buffer.byteLength(out.markdown)<8*1024*1024);
});

test('label declarations preserve the source packs codes and Chinese names',()=>{
  const labels=readJson('../tables/labels.json'),source=readJson('../../case-review/tables/codes.json'),verify=readJson('../../case-review-verify/slots.schema.json');
  assert.deepEqual(labels.probes,source.findings.map(({code,label}:any)=>({code,label})));
  assert.deepEqual(labels.ranks,source.ranks.map(({rank,label}:any)=>({code:rank,label})));
  assert.deepEqual(labels.finalRanks,verify.run.final.ranks);
  assert.deepEqual(labels.dispositions.map(({code,label}:any)=>({code,label})),verify.item.verification.codes);
});

test('source-fact provenance is preserved while verifier errors and model-spoofed payloads stay out of Hub checks',()=>{
  const b=block(['c1','c2','c3','direct']),longText='原样判断'.repeat(800);
  b.result.partitions.delivered[0].requirements[0].claims.push(claim('verified',longText));
  const fact=(nature:string,role:string,producer:string,text:string)=>({qualifier:{nature,source_role:role},warrant:{producer},statement:{verdict:'refute',code:'core.structure.required_empty',text}});
  b.result.partitions.delivered[0].requirements[0].claims.push({
    qualifier:{nature:'fact',source_role:'artifact_under_verification'},warrant:{producer:'function',id:'source_facts'},
    statement:{verdict:'support',data:{source_facts:[
      {reference:'rec:'+'b'.repeat(64)+'#/fact/0',location:ref('c1'),layer:{layer:'static',terminal:'violation',attribution:'author_input'},claim:fact('fact','subject','function','原始字面事实')},
      {reference:'rec:'+'b'.repeat(64)+'#/fact/1',location:ref('c1'),layer:{layer:'static',terminal:'violation',attribution:'author_input'},claim:fact('fact','artifact_under_verification','function','这是评论自身错误')},
      {reference:'rec:'+'b'.repeat(64)+'#/fact/2',location:ref('c1'),layer:{layer:'static',terminal:'violation',attribution:'author_input'},claim:fact('judgment','subject','model','这是伪装的判断')},
    ]}},
  });
  const out=reviewTables(input(small(),[b]));
  assert.equal(out.counts.total.hubChecks,1);assert.ok(out.markdown.includes(longText));assert.ok(out.markdown.includes('原始字面事实'));
  assert.doesNotMatch(out.markdown,/这是评论自身错误|这是伪装的判断/);
});

test('an expected negative-case refutation without source-error attribution is not a Hub problem',()=>{
  const b=block(['c1','c2','c3','direct']),requirement=b.result.partitions.delivered[1].requirements[0];
  requirement.layers=[{layer:'static',terminal:'violation',code:'core.catalog.param_out_of_range'}];
  requirement.claims.push({qualifier:{nature:'fact',source_role:'subject'},warrant:{producer:'function',id:'catalog@1'},
    statement:{verdict:'refute',code:'core.catalog.param_out_of_range',text:'反向用例的预期越界',data:{negative_case:true,expected:true}}});
  const out=reviewTables(input(small(),[b]));assert.equal(out.counts.total.hubChecks,0);assert.ok(!out.markdown.includes('反向用例的预期越界'));
});

test('a mixed requirement never turns its expected refutation into a Hub source defect',()=>{
  const b=block(['c1']);const requirement=b.result.partitions.delivered[0].requirements[0];
  requirement.layers=[{layer:'static',terminal:'violation',code:'core.catalog.not_member',attribution:'author_input'}];
  const expected={qualifier:{nature:'fact',source_role:'subject'},warrant:{producer:'function'},statement:{verdict:'refute',code:'core.catalog.param_out_of_range',text:'合成期望越界',data:{expected:true}}};
  const unexpected={...expected,statement:{verdict:'refute',code:'core.catalog.not_member',text:'合成未知命令',data:{expected:false}}};
  requirement.claims.push(expected,unexpected,{qualifier:{nature:'fact'},warrant:{producer:'function'},statement:{verdict:'support',data:{source_facts:[{location:ref('c1'),reference:'rec:'+SHA,layer:requirement.layers[0],claim:expected}]}}});
  const result=reviewTables(input(small(),[b]));assert.equal(result.counts.total.hubChecks,1);assert.ok(!result.markdown.includes('合成期望越界'));assert.ok(result.markdown.includes('合成未知命令'));
});

test('subitem notes begin after a blank line outside the GFM case table',()=>{
  const b=block(['c1'],[[claim('new_finding','合成子项发现','minor',ref('sub'))]]);
  const lines=reviewTables(input(small(),[b])).markdown.split('\n');const at=lines.findIndex(line=>line.startsWith('子项上的发现：'));
  assert.ok(at>1);assert.equal(lines[at-1],'');assert.match(lines[at-2],/^\| 1 \|/);
});

test('an undelivered nested case and its expected subtree never enter the outer original cell',()=>{
  const model=parse({root:node('root','合成嵌套',[node('group','子项',[node('outer','外层用例',[node('expected','外层期望'),node('inner','未交付内层',[node('inner-e','内层期望')],{resource:['Functional'],priority:2}),node('step','普通步骤',[node('step-e','步骤期望')],{priority:2})],{resource:['Functional'],priority:2})])])});
  for(const caseRule of ['marked','tagged']){const original=projectItems({documents:[{documentId:'synthetic',model}],parameters:{caseRule},limits:{outputBytes:Infinity}});assert.ok('items'in original);assert.ok(original.items.some(item=>item.location.selector==='n/inner'));}
  const result=reviewTables({...input(model,[block(['outer'])]),foldEmpty:false});const row=result.markdown.split('\n').find(line=>line.startsWith('| 1 |'))!;
  assert.ok(!row.includes('未交付内层'));assert.ok(!row.includes('内层期望'));assert.ok(row.includes('普通步骤'));assert.ok(row.includes('步骤期望'));assert.equal(result.counts.total.cases,1);
});

test('frozen character boundaries identify complete subitem prefixes for partial final answers',()=>{
  const result=reviewTables({...input(),foldEmpty:false});const characters=result.counts.characters;
  assert.ok(characters);assert.equal(characters.total,result.markdown.length);assert.equal(characters.subitems.length,result.counts.subitems.length);
  for(const [index,range]of characters.subitems.entries()){
    assert.equal(range.selector,result.counts.subitems[index].selector);assert.ok(result.markdown.slice(range.start,range.end).startsWith(`### ${index+1}.`));
    assert.ok(result.markdown.slice(0,range.end).endsWith('\n'));
    assert.ok(result.markdown.slice(range.end).startsWith(index+1<characters.subitems.length?`### ${index+2}.`:'### 跨子项'));
  }
});

test('a delivered nested case retains its outer source subitem even when the outer case was not delivered',()=>{
  const model=parse({root:node('root','测试项',[node('sub','探测结果',[
    node('outer','后端全部不健康',[node('inner','恢复一台后端后',[node('expect','合成期望')],{resource:['Functional'],priority:2})],{resource:['Functional'],priority:2}),
    node('peer','另一用例',[node('peer-e','合成期望')],{resource:['Functional'],priority:2}),
  ])])});
  const out=reviewTables(input(model,[block(['inner','peer'])]));
  assert.equal(out.counts.subitems.length,1);assert.equal(out.counts.subitems[0].selector,'n/sub');assert.equal(out.counts.subitems[0].counts.cases,2);
  assert.equal(out.counts.total.cases,2);assert.equal((out.markdown.match(/^### \d+\./gm)??[]).length,1);
});
