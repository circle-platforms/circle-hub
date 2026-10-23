import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callPackFunction, osIsolationAvailable, SandboxError } from '../../rules/api.ts';
import { createSubjectBuilder } from './subjects.ts';

test('checks share an exhausted timeout only within the same subject construction scope', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'circle-hub-exhausted-subject-')));
  try {
    await writeFile(join(dir,'slow.ts'),'export default () => {for(;;){}};');
    let attempts=0;
    const execute=async(target: Parameters<typeof callPackFunction>[0],input:unknown)=>(await callPackFunction(target,input,{timeoutMs:200},{requireOsIsolation:await osIsolationAvailable(),retryWallTimeout:true,onAttempt:()=>{attempts++;}})).output;
    const target={packDir:dir,module:'slow.ts'};const build=createSubjectBuilder(execute);
    let first: unknown;
    await assert.rejects(build(target,{item:'one'}),error=>{first=error;return error instanceof SandboxError&&error.code==='SANDBOX_TIMEOUT';});
    await assert.rejects(build(target,{item:'one'}),error=>error===first);
    assert.equal(attempts,2,'two checks share the same bounded retry cycle');
    await assert.rejects(build(target,{item:'two'}));assert.equal(attempts,4);
    await assert.rejects(createSubjectBuilder(execute)(target,{item:'one'}));assert.equal(attempts,6);
  }finally{await rm(dir,{recursive:true,force:true});}
});
