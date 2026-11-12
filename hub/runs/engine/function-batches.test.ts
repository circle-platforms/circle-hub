import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { osIsolationAvailable, SandboxError } from '../../rules/api.ts';
import { createFunctionBatches, splitInputBatches } from './function-batches.ts';

for (const mode of ['throw', 'violate', 'input-limit']) test(`evaluation batch ${mode} preserves individual outcomes and resource caps`, async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-evaluation-batch-')));
  const options={requireOsIsolation:await osIsolationAvailable()}; const spawn=childProcess.spawn; let launches=0;
  try {
    await writeFile(join(dir,'fn.ts'), `export default input => { if(input.fail) throw new Error('synthetic'); if(input.violate) {try {process.binding('fs');} catch {}} return {id:input.id}; };`);
    childProcess.spawn=((...args:Parameters<typeof spawn>)=>{if(args[1]?.some(arg=>String(arg).endsWith('/bootstrap.ts')))launches++;return spawn(...args);}) as typeof spawn;
    syncBuiltinESMExports();
    const batches=createFunctionBatches(()=>options); const ids=['one','bad','two']; batches.define('probe',ids);
    const results=await Promise.allSettled(ids.map(id=>batches.runner('probe',id)({packDir:dir,module:'fn.ts'},
      {id,fail:mode==='throw'&&id==='bad',violate:mode==='violate'&&id==='bad',text:mode==='input-limit'?'x'.repeat(1500):''},
      mode==='input-limit'?{inputBytes:2048}:{},options)));
    assert.equal(results[0].status,'fulfilled'); assert.equal(results[2].status,'fulfilled');
    if(mode==='input-limit'){assert.equal(results[1].status,'fulfilled');assert.equal(launches,3);}
    else {
      assert.equal(results[1].status,'rejected'); const error=(results[1] as PromiseRejectedResult).reason;
      assert.ok(error instanceof SandboxError); assert.equal(error.code,mode==='throw'?'FUNCTION_THREW':'SANDBOX_VIOLATION');
      assert.equal(launches,mode==='throw'?1:4);
    }
    for(const [index,result]of results.entries())if(result.status==='fulfilled')assert.deepEqual(result.value.output,{id:ids[index]});
  } finally {childProcess.spawn=spawn;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true});}
});

test('input batches retain exact UTF-8 fits and isolate an oversized item', () => {
  const inputs=['逐'.repeat(500),'ok','x'.repeat(5000)];
  const inputBytes=Buffer.byteLength(JSON.stringify(inputs.slice(0,2)));
  assert.deepEqual(splitInputBatches(inputs,inputBytes),[inputs.slice(0,2),[inputs[2]]]);
});

test('34 UTF-8 inputs stay in ordered byte-bounded batches instead of falling back to individual launches', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-evaluation-batch-')));
  const options={requireOsIsolation:await osIsolationAvailable()}; const spawn=childProcess.spawn; let launches=0;
  try {
    await writeFile(join(dir,'fn.ts'),'export default input => ({id:input.id,length:input.text.length});');
    childProcess.spawn=((...args:Parameters<typeof spawn>)=>{if(args[1]?.some(arg=>String(arg).endsWith('/bootstrap.ts')))launches++;return spawn(...args);}) as typeof spawn;
    syncBuiltinESMExports();
    const ids=Array.from({length:34},(_,index)=>`item-${String(index).padStart(2,'0')}`);
    const batches=createFunctionBatches(()=>options); batches.define('probe',ids);
    const results=await Promise.all(ids.map(id=>batches.runner('probe',id)({packDir:dir,module:'fn.ts'},
      {id,text:'逐'.repeat(500)},{inputBytes:4096},options)));
    assert.equal(launches,17,'two roughly 1.5 KB UTF-8 inputs fit each 4 KB batch');
    assert.deepEqual(results.map(result=>result.output),ids.map(id=>({id,length:500})));
  } finally {childProcess.spawn=spawn;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true});}
});

test('an aggregate violation falls back only within its own byte-bounded batch', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-evaluation-batch-')));
  const options={requireOsIsolation:await osIsolationAvailable()}; const spawn=childProcess.spawn; let launches=0;
  try {
    await writeFile(join(dir,'fn.ts'),`export default input => { if(input.violate) {try {process.binding('fs');} catch {}} return {id:input.id}; };`);
    childProcess.spawn=((...args:Parameters<typeof spawn>)=>{if(args[1]?.some(arg=>String(arg).endsWith('/bootstrap.ts')))launches++;return spawn(...args);}) as typeof spawn;
    syncBuiltinESMExports();
    const ids=Array.from({length:6},(_,index)=>`item-${index}`); const batches=createFunctionBatches(()=>options); batches.define('probe',ids);
    const results=await Promise.allSettled(ids.map((id,index)=>batches.runner('probe',id)({packDir:dir,module:'fn.ts'},
      {id,violate:index===0,text:'逐'.repeat(500)},{inputBytes:4096},options)));
    assert.equal(results[0].status,'rejected'); assert.ok((results[0] as PromiseRejectedResult).reason instanceof SandboxError);
    assert.equal((results[0] as PromiseRejectedResult).reason.code,'SANDBOX_VIOLATION');
    for(const [index,result] of results.entries())if(index>0){assert.equal(result.status,'fulfilled');assert.deepEqual(result.value.output,{id:ids[index]});}
    assert.equal(launches,5,'the failed two-item batch uses three launches and the remaining two batches use one each');
  } finally {childProcess.spawn=spawn;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true});}
});

test('a check that never calls its function does not leave other items waiting', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-evaluation-batch-')));
  try {
    await writeFile(join(dir,'fn.ts'),'export default input => input;');
    const options={requireOsIsolation:await osIsolationAvailable()};const batches=createFunctionBatches(()=>options);
    batches.define('probe',['one','skipped']);
    const pending=batches.runner('probe','one')({packDir:dir,module:'fn.ts'},{id:'one'},{},options);
    batches.finish('probe','skipped'); assert.deepEqual((await pending).output,{id:'one'});
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('cancelled groups never dispatch when their remaining items finish', async () => {
  const batches=createFunctionBatches(()=>({}));batches.define('probe',['one','two','skipped']);
  const target={packDir:'/synthetic-cancelled',module:'fn.ts'};
  const first=batches.runner('probe','one')(target,{}); const second=batches.runner('probe','two')(target,{});
  first.catch(()=>{});second.catch(()=>{});
  const error=new SandboxError('SANDBOX_UNAVAILABLE',{reason:'stopping'});batches.cancel(error);batches.finish('probe','skipped');
  await assert.rejects(first,value=>value===error); await assert.rejects(second,value=>value===error);
  await assert.rejects(batches.runner('probe','skipped')(target,{}),value=>value===error);
});
