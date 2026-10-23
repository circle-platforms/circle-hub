import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { osIsolationAvailable, SandboxError } from '../../rules/api.ts';
import { createFunctionBatches } from './function-batches.ts';

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
