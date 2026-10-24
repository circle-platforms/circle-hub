import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown, markdownDocument, utf8 } from '../testing/test-support.ts';
import { textParser } from '../../../../hub/refs/api.ts';
import { produceManualEntries } from './manual.ts';
import { canonicalJson } from './util.ts';

const options={components:['Card-A','Card-B'],licenses:['Permit-A'],deployment_forms:['Form-A']};
const source='# Outer 装有 Card-A 时\n\n内存至少8GB。\n\n## Middle\n\n需要 Permit-A 许可。\n\n### Inner\n\n**demo value** *\\<name\\>*\n\n普通正文。\n\n| 参数 | 说明 |\n| --- | --- |\n| mode | ordinary |\n';
const result=(text=source)=>produceManualEntries(markdown(text),null,options);
const payload=(entry:any)=>canonicalJson({kind:entry.kind,statement:entry.statement,data:entry.data,applicability:entry.applicability});

test('title and opening paragraph conditions reach third-level text, signatures and table rows',()=>{
  const out=result();
  const entries=[out.entries.find(e=>e.statement==='普通正文。'),out.entries.find(e=>e.data.form==='signature'),out.entries.find(e=>e.statement.includes('ordinary'))];
  for(const entry of entries){assert.ok(entry);assert.deepEqual(entry.applicability?.components,{with:['Card-A']});assert.equal(entry.applicability?.memory?.minimum?.bytes,8*1024**3);assert.deepEqual(entry.applicability?.licenses,['Permit-A']);assert.deepEqual(new Set(entry.applicability?.inherited),new Set(['components','memory','licenses']));assert.ok(entry.fragments.slice(1).some(fragment=>fragment.applicability?.length));}
});
test('every inherited origin reads the original text and names only the corresponding field',()=>{
  const out=result();const document=markdownDocument(source);const lines=textParser.parse(utf8(source));
  const entry=out.entries.find(e=>e.statement==='普通正文。')!;
  for(const fragment of entry.fragments.slice(1)){
    const located=(fragment.parser==='text@1'?lines:document).locate(fragment.selector);assert.ok(located,fragment.selector);
    for(const origin of fragment.applicability??[]){assert.ok(origin.declaration[origin.field]);assert.ok(origin.section.length);assert.ok(located.text.includes(origin.field==='components'?'Card-A':origin.field==='memory'?'内存':'Permit-A'));}
  }
});
test('renaming a chapter changes provenance rather than the unchanged inherited entry content',()=>{
  const before=result();const after=result(source.replace('Outer 装有','Renamed 装有'));
  const a=before.entries.find(e=>e.statement==='普通正文。')!;const b=after.entries.find(e=>e.statement==='普通正文。')!;
  assert.equal(payload(a),payload(b));assert.notDeepEqual(a.fragments,b.fragments);
  assert.equal(JSON.stringify(result()),JSON.stringify(result()));
});
test('inner and own fields use scope priority while different fields merge and overrides remain reported',()=>{
  const out=result('# Outer 装有 Card-A 时\n\n内存至少8GB。\n\n## Inner\n\n装有 Card-B 时。\n\n需要 Permit-A 许可。\n\n普通正文。\n');
  const body=out.entries.find(e=>e.statement==='普通正文。')!;
  assert.deepEqual(body.applicability?.components,{with:['Card-B']});assert.equal(body.applicability?.memory?.minimum?.bytes,8*1024**3);
  const own=out.entries.find(e=>e.statement==='需要 Permit-A 许可。')!;assert.deepEqual(own.applicability?.licenses,['Permit-A']);assert.ok(!own.applicability?.inherited?.includes('licenses'));
  assert.ok(out.applicability_report?.overrides.some(row=>row.field==='components'));
});
test('same-section conflicts retain both values and origins, omit that field and never fall back outward',()=>{
  const out=result('# Outer 装有 Card-A 时\n\n## Inner 装有 Card-A 时\n\n装有 Card-B 时。\n\n### Leaf\n\n普通正文。\n');
  const body=out.entries.find(e=>e.statement==='普通正文。')!;
  assert.equal(body.applicability?.components,undefined);
  const origins=body.fragments.flatMap(fragment=>fragment.applicability??[]).filter(origin=>origin.field==='components'&&!origin.superseded);
  assert.equal(origins.length,2);assert.ok(origins.every(origin=>origin.conflict));
  assert.deepEqual(new Set(origins.flatMap(origin=>origin.declaration.components?.with??[])),new Set(['Card-A','Card-B']));
  assert.equal(out.applicability_report?.conflicts.length,1);
});
test('a paragraph after a nonparagraph block is not a chapter opening',()=>{
  const out=result('# Outer\n\n```text\nexample\n```\n\n装有 Card-A 时。\n\n## Inner\n\n普通正文。\n');
  assert.equal(out.entries.find(e=>e.statement==='普通正文。')!.applicability,null);
});

test('ordinary absence prose never blocks an outer component declaration',()=>{
  for(const prose of ['没有输出时，检查端口状态。','没有配置该命令时，系统给出提示。','当没有告警时，指示灯熄灭。','没有响应时请重启。']){
    const out=result('# Outer 装有 Card-A 时\n\n## Inner\n\n'+prose+'\n\n### Leaf\n\n普通正文。\n');
    const entry=out.entries.find(row=>row.statement==='普通正文。')!;
    assert.deepEqual(entry.applicability?.components,{with:['Card-A']},prose);
    assert.ok(!entry.fragments.flatMap(fragment=>fragment.applicability??[]).some(origin=>origin.declaration[origin.field]===undefined),prose);
  }
});
test('empty closed sets do not invent unread declarations from ordinary or closed-name prose',()=>{
  const out=produceManualEntries(markdown('# Outer\n\n## Inner\n\n没有输出时需要管理员许可，适用于 Form-A 部署形态。\n\n普通正文。\n'),null,{components:[],licenses:[],deployment_forms:[]});
  assert.ok(out.entries.every(entry=>entry.applicability===null));
  assert.ok(out.entries.every(entry=>!entry.fragments.some(fragment=>fragment.applicability?.length)));
});
test('an explicit unknown part or mixed closed list still blocks a narrower inherited condition',()=>{
  for(const prose of ['没有未知部件时。','装有 Card-A、Unknown 时。']){
    const out=result('# Outer 装有 Card-A 时\n\n## Inner\n\n'+prose+'\n\n普通正文。\n');
    const entry=out.entries.find(row=>row.statement==='普通正文。')!;
    assert.equal(entry.applicability?.components,undefined,prose);
    assert.ok(entry.fragments.some(fragment=>fragment.applicability?.some(origin=>origin.field==='components'&&origin.declaration.components===undefined)),prose);
  }
});

test('an overridden outer declaration remains attached with a superseded marker',()=>{
  const out=result('# Outer 装有 Card-A 时\n\n## Inner\n\n装有 Card-B 时。\n\n普通正文。\n');
  const entry=out.entries.find(row=>row.statement==='普通正文。')!;
  const origins=entry.fragments.flatMap(fragment=>fragment.applicability??[]).filter(origin=>origin.field==='components');
  assert.deepEqual(origins.filter(origin=>origin.superseded).map(origin=>origin.declaration.components),[{with:['Card-A']}]);
  assert.deepEqual(origins.filter(origin=>!origin.superseded).map(origin=>origin.declaration.components),[{with:['Card-B']}]);
  const direct=out.entries.find(row=>row.statement==='装有 Card-B 时。')!;
  assert.ok(direct.fragments.some(fragment=>fragment.applicability?.some(origin=>origin.superseded)));
});
