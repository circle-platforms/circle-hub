import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {callPackFunction, SandboxError, osIsolationAvailable} from '../api.ts';

for(const mode of ['throw','event'])test(`spawn ${mode} keeps its private cause without putting it in attempts`,async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-spawn-cause-')));
  const original=childProcess.spawn;const attempts:unknown[]=[];let calls=0;
  try{
    await writeFile(join(dir,'fn.ts'),'export default () => 7;');
    childProcess.spawn=((...args:Parameters<typeof original>)=>{
      if(!args[1]?.some(arg=>String(arg).endsWith('/bootstrap.ts')))return original(...args);
      calls++;
      if(mode==='throw')throw Object.assign(new Error('SyntheticSpawnPrivateCause'),{code:'EAGAIN'});
      return original(join(dir,'synthetic-missing-node'),args[1],args[2]);
    }) as typeof original;syncBuiltinESMExports();
    await assert.rejects(callPackFunction({packDir:dir,module:'fn.ts'},null,{}, {requireOsIsolation:await osIsolationAvailable(),onAttempt:value=>attempts.push(value)}),error=>{
      assert.ok(error instanceof SandboxError);assert.equal(error.code,'SANDBOX_UNAVAILABLE');
      assert.equal(error.detail.reason,'spawn_failed');assert.equal(error.detail.errno,mode==='throw'?'EAGAIN':'ENOENT');
      assert.match(String(error.detail.message),mode==='throw'?/SyntheticSpawnPrivateCause/:/synthetic-missing-node/);
      assert.ok(!error.message.includes(dir));assert.ok(!error.message.includes('SyntheticSpawnPrivateCause'));
      return true;
    });
    assert.equal(calls,3);assert.equal(attempts.length,3);
    assert.ok(!JSON.stringify(attempts).includes(dir));assert.ok(!JSON.stringify(attempts).includes('SyntheticSpawnPrivateCause'));
  }finally{childProcess.spawn=original;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true});}
});
