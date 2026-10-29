import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {SESSION,scratch,fakeHub,enable,hook,skill} from './operation-support.ts';

test('identical operation proposals retain one key while distinct proposals on the same source do not collide',async t=>{
  const local=await scratch(t),hub=await fakeHub(t);
  assert.equal((await enable(local,hub.url)).code,0);
  assert.equal((await hook(local,'ORBIT synthetic status: ready\n')).code,0);
  const capture=[...hub.uploads.keys()][0]!;
  const item={capture,kind:'observation',path:'/commands/system/show',statement:'记录合成状态',action:'查看合成状态',quote:{line:1,text:'ORBIT synthetic status: ready'}};
  const proposal=join(local.home,'intent.json');
  const submit=async(value:unknown,model='synthetic-model')=>{
    await writeFile(proposal,JSON.stringify({schema:'operation-integration@1',session:SESSION,items:Array.isArray(value)?value:[value]}));
    const result=await skill(local,['submit','--session',SESSION,'--proposals',proposal,'--product','ORBIT','--build','ORBIT-synthetic-1','--model',model]);
    assert.equal(result.code,0,result.err);
  };
  await submit(item);
  await submit(item);
  await submit({...item,statement:'另一条合成观察'});
  const pitfall={capture,kind:'pitfall',path:item.path,statement:'合成注意事项',phenomenon:'合成状态已显示',suggestion:'核对合成输入',quote:item.quote};
  await submit(pitfall);
  await submit(item,'another-synthetic-model');
  await submit({...item,path:'/commands/system/inspect'});
  await submit({...item,quote:{line:1,text:'status: ready'}});
  await submit([item,pitfall]);
  await submit([pitfall,item]);
  const keys=hub.runs.map(run=>run.client_key);
  assert.equal(keys.length,9);
  assert.equal(keys[0],keys[1]);
  assert.equal(new Set([keys[0],...keys.slice(2)]).size,8);
});
