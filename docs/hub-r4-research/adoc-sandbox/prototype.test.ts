// All test inputs are synthetic. Preparation downloads pinned public artifacts on the host; these tests never fetch.
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { callPackFunction, osIsolationAvailable, SandboxError } from '../../../hub/rules/api.ts';
import { prepared, sha256 } from './prepare.ts';
import { DEFAULT_SANDBOX } from '../../../hub/knowledge/api.ts';
import { files, scaled } from './sample.ts';

let packDir:string;
const isolated=await osIsolationAvailable();
const skip=isolated?false:'OS network isolation unavailable; never relax the real sandbox for this research';
before(async()=>{
  packDir=await mkdtemp(join(tmpdir(),'circle-adoc-prototype-'));
  for(const file of ['probe.ts','legacy.ts']) await copyFile(new URL(file,import.meta.url),join(packDir,file));
  await writeFile(join(packDir,'core.mjs'),await prepared('4.1.1'));
  await writeFile(join(packDir,'core-3.mjs'),await prepared('3.0.4'));
  await writeFile(join(packDir,'bare.ts'),"import '@asciidoctor/core'; export default ()=>null;");
  await writeFile(join(packDir,'clock.ts'),`export default async function(input:any){const RealDate=Date;if(input.entry==='probe.ts')globalThis.Date=class extends RealDate{constructor(...args:any[]){super(args.length?args[0]:input.clock)}static now(){return input.clock}} as DateConstructor;else Date.now=()=>input.clock;Math.random=()=>input.random;const fn=await import('./'+input.entry);return fn.default(input.payload);}`);
});
after(()=>packDir&&rm(packDir,{recursive:true,force:true}));
const call=(input:unknown,module='probe.ts',limits={})=>callPackFunction({packDir,module},input,limits);
const sample={root:'manual.adoc',files};
const stats=(stdout:string)=>JSON.parse(stdout.trim().split('\n').at(-1)!);

test('native browser bundle extracts author hierarchy, cells, lists, raw signatures and reference-only examples',{skip},async()=>{
  const r=await call(sample),d=r.output as any;
  assert.equal(r.osIsolation,true);assert.equal(r.stderr,'');
  assert.deepEqual(d.sections.map((s:any)=>[s.title,s.level,s.id]),[['Pools',1,'pools'],['Add a pool',2,'pool-add']]);
  assert.deepEqual(d.sections[1].path.map((s:any)=>s.id),['pools','pool-add']);
  assert.deepEqual(d.tables[0].rows.body.map((r:any[])=>r.map(c=>c.text)),[['name','1-32 characters','Pool identifier'],['interval','1-60','Probe interval in seconds'],['mode','on, off','Allowed modes']]);
  assert.equal(d.tables[0].rows.body[1][1].origin.src,'chapters/pool.adoc:10');
  assert.deepEqual(d.lists.map((l:any)=>l.kind),['ulist','ulist','olist']);
  assert.deepEqual(d.signatures.map((s:any)=>s.src),['chapters/pool.adoc:4','chapters/pool.adoc:17']);
  assert.equal(d.signatures[0].signature_verbatim,'*{cmd}* _<name>_ _[interval]_');
  assert.equal(d.signatures[0].expanded,'*demo pool add* _<name>_ _[interval]_');
  for(const s of d.signatures)assert.equal(files[s.file].split('\n')[s.line-1],s.signature_verbatim,'verbatim resolves back to exact original line');
  assert.equal(d.examples[0].reference_only,true);
  assert.ok(!d.signatures.some((s:any)=>s.signature_verbatim===d.examples[0].source));
});

test('fresh processes give identical artifact bytes under different clocks/random values (native and Opal)',{skip},async t=>{
  for(const entry of ['probe.ts','legacy.ts']){
    const payload=entry==='probe.ts'?sample:{text:'= Synthetic\n\n== Commands\n\n*demo set* _<n>_'};
    const a=await call({clock:0,random:0.1,entry,payload},'clock.ts');
    const b=await call({clock:2524608000000,random:0.9,entry,payload},'clock.ts');
    assert.equal(JSON.stringify(a.output),JSON.stringify(b.output));
    assert.equal(sha256(JSON.stringify(a.output)),sha256(JSON.stringify(b.output)));
    t.diagnostic(JSON.stringify({determinism:entry,bytes:Buffer.byteLength(JSON.stringify(a.output)),sha256:sha256(JSON.stringify(a.output))}));
  }
});

test('scoped attribute changes are replayed in source order without losing raw provenance',{skip},async()=>{
  const source='= Scoped\n:cmd: demo one\n\n== Commands\n\n*{cmd}*\n\n:cmd: demo two\n\n*{cmd}*\n';
  const r=await call({root:'scoped.adoc',files:{'scoped.adoc':source}}),d=r.output as any;
  assert.deepEqual(d.signatures.map((s:any)=>s.expanded),['*demo one*','*demo two*']);
  assert.deepEqual(d.signatures.map((s:any)=>s.src),['scoped.adoc:6','scoped.adoc:10']);
  assert.ok(d.signatures.every((s:any)=>s.signature_verbatim==='*{cmd}*'));
});

test('native include fails closed even in secure mode; memory-only adapter rejects missing, remote and cyclic sources',{skip},async()=>{
  await assert.rejects(call({...sample,mode:'native-include'}),(e:unknown)=>e instanceof SandboxError&&e.code==='IMPORT_NOT_DECLARED'&&e.detail.what==='node:fs/promises');
  for(const text of ['include::missing.adoc[]','include::https://192.0.2.1/manual.adoc[]','include::../outside.adoc[]','include::manual.adoc[]','include::chapters/pool.adoc[lines=1..3]','== {docdate}','ifdef::missing[]',' :!x:'.trim()]){
    await assert.rejects(call({root:'manual.adoc',files:{...files,'manual.adoc':text}}),(e:unknown)=>e instanceof SandboxError&&e.code==='FUNCTION_THREW');
  }
});

test('Opal memory include works but its last included block source path is not reliable',{skip},async()=>{
  const r=await call({text:'= Main\n\ninclude::chapter.adoc[]',include:true},'legacy.ts'),nodes=r.output as any[];
  assert.equal(nodes.find(n=>n.context==='section'&&n.title==='Included').path,'chapter.adoc');
  assert.equal(nodes.find(n=>n.context==='paragraph').path,'<stdin>','known EOF sourcemap defect must not become a trusted catalog source');
});

test('the same unchanged sandbox rejects network, writes and process creation',{skip},async()=>{
  await assert.rejects(call(null,'bare.ts'),(e:unknown)=>e instanceof SandboxError&&e.code==='IMPORT_NOT_DECLARED');
  for(const mode of ['network','write','spawn'])await assert.rejects(call({...sample,mode}),(e:unknown)=>e instanceof SandboxError&&['IMPORT_NOT_DECLARED','SANDBOX_VIOLATION'].includes(e.code));
});

test('synthetic manual sizes under generic package-function limits',{skip,timeout:90_000},async t=>{
  for(const requested of [256*1024,1024*1024,3*1024*1024]){
    const input=scaled(requested);
    try{
      const r=await call(input);
      const metric=stats(r.stdout);
      assert.equal(r.osIsolation,true);
      assert.ok(Buffer.byteLength(JSON.stringify(r.output))<=8*1024*1024);
      t.diagnostic(JSON.stringify({requested,status:'ok',wallMs:r.durationMs,...metric}));
    }catch(e){
      assert.ok(e instanceof SandboxError);assert.ok(['SANDBOX_OUTPUT_TOO_LARGE','SANDBOX_TIMEOUT','SANDBOX_VIOLATION'].includes(e.code));
      t.diagnostic(JSON.stringify({requested,status:e.code,detail:e.detail,metrics:e.stdout.trim()?stats(e.stdout):null}));
    }
  }
  // Diagnosis only: an override in this synthetic call does not change the Hub defaults.
  const input=scaled(3*1024*1024);
  try{
    const r=await call(input,'probe.ts',{memoryMb:1024,timeoutMs:30_000});
    t.diagnostic(JSON.stringify({requested:3*1024*1024,limits:'research-only memory=1024MiB',status:'ok',wallMs:r.durationMs,...stats(r.stdout)}));
  }catch(e){
    assert.ok(e instanceof SandboxError);
    assert.equal(e.code,'SANDBOX_OUTPUT_TOO_LARGE');
    t.diagnostic(JSON.stringify({requested:3*1024*1024,limits:'research-only memory=1024MiB',status:e.code,detail:e.detail,metrics:stats(e.stdout)}));
  }

});


test('synthetic manuals fit the actual knowledge-producer defaults without changing the sandbox',{skip,timeout:90_000},async t=>{
  assert.deepEqual(DEFAULT_SANDBOX.producer,{timeoutMs:120_000,memoryMb:1024,inputBytes:128*1024*1024,outputBytes:64*1024*1024});
  for(const requested of [256*1024,1024*1024,3*1024*1024]){
    const r=await call(scaled(requested),'probe.ts',DEFAULT_SANDBOX.producer);
    const metric=stats(r.stdout);
    assert.equal(r.osIsolation,true);
    assert.ok(metric.maxRssKiB < (1024+192)*1024);
    assert.ok(Buffer.byteLength(JSON.stringify(r.output))<=64*1024*1024);
    t.diagnostic(JSON.stringify({profile:'knowledge-producer',requested,inputSha256:sha256(scaled(requested).files['scale.adoc']),outputSha256:sha256(JSON.stringify(r.output)),wallMs:r.durationMs,...metric}));
  }
});
