import {writeFileSync} from 'node:fs';
import {fixture,positiveBlocks} from './blocks.ts';
const f=fixture();
for(const [kind,data]of Object.entries(positiveBlocks())){
 const subject=f.subject(data).subject;
 for(const negative of [false,true]){
  const value=structuredClone(subject);if(negative)value.data={...data,steps:[{object:'ORBIT_0',method:'command',args:['demo show'],keywords:{}}]};
  writeFileSync(new URL(`../samples/${negative?'negative':'positive'}/typed-block-${kind}.json`,import.meta.url),JSON.stringify({id:'block_'+kind.toLowerCase()+(negative?'_negative':'_positive'),source:'author',check:'contract_shape',note:'合成 ORBIT/COMET 块模型；不证明实际运行器已具备能力',subject:value,expect:[{verdict:negative?'refute':'support',...(negative?{code:'case-compile.slots_invalid'}:{}),item:'synthetic-case',tier:'blocking'}]},null,2)+'\n');
 }
}
