// Deployment vocabularies are synthetic and supplied as producer options, never shipped product values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown } from '../testing/test-support.ts';
import { produceManualEntries } from './manual.ts';
import type { ManualOptions } from './types.ts';
import { manual as producer } from './producers.ts';

const closed={components:['Card-A','Card-B'],licenses:['Permit-A','Permit-B'],deployment_forms:['Form-A','Form-B']};
function entry(text:string,options:ManualOptions=closed){
  const out=produceManualEntries(markdown('# Synthetic chapter\n\n'+text+'\n'),null,options);
  const found=out.entries.find(row=>row.statement===text);assert.ok(found,JSON.stringify(out));return found;
}
test('each closed applicability field reads explicit phrases including component absence',()=>{
  assert.deepEqual(entry('装有 Card-A、Card-B 时。').applicability,{components:{with:['Card-A','Card-B']}});
  assert.deepEqual(entry('装有 Card-A 部件时。').applicability,{components:{with:['Card-A']}});
  assert.deepEqual(entry('没有 Card-B 时。').applicability,{components:{without:['Card-B']}});
  assert.deepEqual(entry('需要 Permit-A 许可。').applicability,{licenses:['Permit-A']});
  assert.deepEqual(entry('适用于 Form-A、Form-B。').applicability,{deployment_forms:['Form-A','Form-B']});
  assert.deepEqual(entry('仅 Form-A 支持。').applicability,{deployment_forms:['Form-A']});
});
test('an unreadable list member, negation, exception or empty vocabulary never becomes a partial condition',()=>{
  for(const text of ['装有 Card-A、Unknown 时。','需要 Permit-A、Unknown 许可。','适用于 Form-A、Unknown。','不需要 Permit-A 许可。','适用于 Form-A 以外。','可能适用于 Form-A。','仅 Form-A 支持，但 Form-B 除外。'])assert.equal(entry(text).applicability,null,text);
  assert.equal(entry('装有 Card-A 时。',{components:[],licenses:[],deployment_forms:[]}).applicability,null);
});
test('the product producer forwards the resolved closed vocabularies',()=>{
  const text='需要 Permit-A 许可。';
  const out=producer({slots:{cli:{parser:'markdown@1',model:markdown('# Synthetic\n\n'+text+'\n')}},params:closed});
  assert.deepEqual(out.entries.find(row=>row.statement===text)?.applicability,{licenses:['Permit-A']});
});

for(const [text,side,inclusive] of [
  ['内存不少于 8 GB。','minimum',true],['内存至少 8G。','minimum',true],['内存大于 8GB。','minimum',false],
  ['内存小于 8GB。','maximum',false],['内存不超过 8GB。','maximum',true],['内存 8GB 以上。','minimum',true],['内存 8GB 以下。','maximum',true],
] as const)test('memory relation preserves its endpoint '+text,()=>{
  const memory=entry(text).applicability?.memory;assert.ok(memory);
  assert.deepEqual(memory[side],{bytes:8*1024**3,inclusive});
  assert.equal(memory.raw,text.slice(0,-1));
});
for(const [unit,factor] of [['GB',1024**3],['G',1024**3],['MB',1024**2],['M',1024**2]] as const)test('memory unit converts exactly '+unit,()=>{
  assert.deepEqual(entry('内存至少 2'+unit+'。').applicability?.memory?.minimum,{bytes:2*factor,inclusive:true});
});
test('an explicit size is equality and exact fractional sizes are not rounded',()=>{
  const memory=entry('16 G 内存的设备。').applicability?.memory;assert.ok(memory);
  assert.deepEqual(memory.minimum,{bytes:16*1024**3,inclusive:true});assert.deepEqual(memory.maximum,memory.minimum);
  assert.equal(entry('内存至少1.5GB。').applicability?.memory?.minimum?.bytes,3*1024**3/2);
  assert.equal(entry('内存至少0.1GB。').applicability,null);
});
test('vague memory, negation, exceptions, unsupported units and unsafe numbers stay in the source',()=>{
  for(const text of ['内存较大时。','不适用于16G内存的设备。','内存至少8GB以外。','约16G内存的设备。','内存至少8TB。','内存至少999999999999999999GB。','内存大于8GB或内存小于4GB。'])assert.equal(entry(text).applicability,null,text);
});

test('an explicit absence and a memory bound retain their independent fields',()=>{
  const value=entry('没有 Card-B 时，内存不超过8GB。').applicability;
  assert.deepEqual(value?.components,{without:['Card-B']});
  assert.deepEqual(value?.memory?.maximum,{bytes:8*1024**3,inclusive:true});
});
