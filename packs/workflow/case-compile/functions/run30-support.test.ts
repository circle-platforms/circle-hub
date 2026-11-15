import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planStateOf } from './plan-state.ts';
import { fetchBytesRetrying, sourceFileName } from './hub-retry.ts';
import { sha256 } from './generated/skills/run-tools/hub-client/index.ts';
test('declared skip and frozen exclusion share stage eligibility without a claim of impossibility',()=>{
  assert.equal(planStateOf({item:'x',handling:'skipped'}).process,false);
  assert.equal(planStateOf({item:'x',handling:'handled'},new Set(['x'])).process,false);
  assert.equal(planStateOf({item:'x',handling:'handled'}).process,true);
  assert.match(planStateOf({item:'x',handling:'skipped'}).reason!,/尚未因此核验为真/);
});
test('source names are derived from explicit slot and media type',()=>{
  assert.equal(sourceFileName('contract','application/json'),'contract.json');assert.equal(sourceFileName('subject','text/plain',1),'subject-1.txt');assert.throws(()=>sourceFileName('../escape','application/json'));
});
test('immutable sources share verified local bytes within one origin and credential scope',async()=>{
  const cwd=process.cwd(),dir=await mkdtemp(join(tmpdir(),'cc-source-cache-'));
  try{process.chdir(dir);const bytes=Buffer.from('synthetic source'),hash=sha256(bytes),url=`http://127.0.0.1:1/run-export/run_${'a'.repeat(26)}/sources/${hash}`;let reads=0;
    const control={fetch:async()=>{reads++;return new Response(bytes);}} as unknown as NonNullable<Parameters<typeof fetchBytesRetrying>[3]>;
    assert.deepEqual(Buffer.from((await fetchBytesRetrying(url,'synthetic-a',100,control)).bytes),bytes);
    assert.deepEqual(Buffer.from((await fetchBytesRetrying(url,'synthetic-a',100,control)).bytes),bytes);assert.equal(reads,1);
    await fetchBytesRetrying(url,'synthetic-b',100,control);assert.equal(reads,2);
    await fetchBytesRetrying(url.replace(/sources\/.+$/,'jobs'),'synthetic-a',100,control);await fetchBytesRetrying(url.replace(/sources\/.+$/,'jobs'),'synthetic-a',100,control);assert.equal(reads,4);
  }finally{process.chdir(cwd);await rm(dir,{recursive:true,force:true});}
});
