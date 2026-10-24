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
