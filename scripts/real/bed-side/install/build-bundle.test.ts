import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';

const {buildBundle} = await import(new URL('./build-bundle.mjs',import.meta.url).href);
const names = ['entry.py','cell_gateway.py','cell_runtime.py','table_cell.py','test_xlsx.py'];
const hash = (bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(t:TestContext) {
  const root=mkdtempSync(join(tmpdir(),'cell-offline-bundle-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo');mkdirSync(join(repo,'scripts/real/bed-side'),{recursive:true});
  const git=(args:string[])=>{const p=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
  git(['init','--quiet']);
  for(const name of names)writeFileSync(join(repo,'scripts/real/bed-side',name),`raise RuntimeError("synthetic frozen ${name}: must not execute")\n`);
  git(['add','scripts/real/bed-side']);
  git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic snapshot']);
  const commit=git(['rev-parse','HEAD']);
  const installer=join(root,'installer.py'),observer=join(root,'observe.py');
  writeFileSync(installer,'raise RuntimeError("must not install")\n');writeFileSync(observer,'raise RuntimeError("must not observe real host")\n');
  return {root,repo,commit,installer,observer,out:join(root,'bundle')};
}

test('the offline bundle uses five immutable Git blobs, includes both scripts and records byte hashes',t=>{
  const f=fixture(t);writeFileSync(join(f.repo,'scripts/real/bed-side/entry.py'),'working tree differs');
  const plan=buildBundle(f);
  assert.equal(plan.source_commit,f.commit);
  for(const name of names){const bytes=readFileSync(join(f.out,'bed-side',name));assert.match(bytes.toString(),/synthetic frozen/);assert.equal(plan.component_sha256[name],hash(bytes));}
  for(const [name,field] of [['installer.py','installer_sha256'],['observe.py','checker_sha256']])assert.equal(plan[field],hash(readFileSync(join(f.out,'install',name))));
  assert.deepEqual(JSON.parse(readFileSync(join(f.out,'install-plan.json'),'utf8')),plan);
});

test('operator materials may be absent only as explicit not-ready facts',t=>{
  const f=fixture(t),plan=buildBundle(f);
  assert.equal(plan.base_hub_sha256,null);assert.equal(plan.objects,null);
  assert.deepEqual(plan.missing_requirements,['base-hub-contract.json','objects']);
  assert.equal(existsSync(join(f.out,'base-hub-contract.json')),false);
});

test('explicit rule bytes and object names are preserved without invented identities',t=>{
  const f=fixture(t),baseHubContract=join(f.root,'rules.json'),objectsFile=join(f.root,'objects.json');
  const base=Buffer.from('{"schema":"runtime-contract@2","synthetic":true}\n');
  writeFileSync(baseHubContract,base);writeFileSync(objectsFile,JSON.stringify(['exact device name','another-object']));
  const plan=buildBundle({...f,baseHubContract,objectsFile});
  assert.deepEqual(readFileSync(join(f.out,'base-hub-contract.json')),base);
  assert.equal(plan.base_hub_sha256,hash(base));assert.deepEqual(plan.objects,['exact device name','another-object']);assert.deepEqual(plan.missing_requirements,[]);
});

test('partial revisions, unknown commits and missing runtime blobs cannot produce a bundle',t=>{
  const f=fixture(t);
  for(const commit of [f.commit.slice(0,10),'HEAD','0'.repeat(40)])assert.throws(()=>buildBundle({...f,commit}));
  assert.equal(spawnSync('git',['-C',f.repo,'rm','--cached','scripts/real/bed-side/entry.py']).status,0);
  assert.equal(spawnSync('git',['-C',f.repo,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic missing blob']).status,0);
  const missingCommit=spawnSync('git',['-C',f.repo,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  assert.throws(()=>buildBundle({...f,commit:missingCommit}));
  assert.equal(existsSync(f.out),false);
});

test('missing scripts, malformed inventories and existing destinations fail without overwrite',t=>{
  const f=fixture(t),objectsFile=join(f.root,'objects.json');
  assert.throws(()=>buildBundle({...f,observer:join(f.root,'absent.py')}));
  for(const objects of [[],['a','a'],[' '],['a',1],{name:'a'}]){writeFileSync(objectsFile,JSON.stringify(objects));assert.throws(()=>buildBundle({...f,objectsFile}));}
  assert.equal(existsSync(f.out),false);
  mkdirSync(f.out);writeFileSync(join(f.out,'keep'),'untouched');assert.throws(()=>buildBundle(f));assert.equal(readFileSync(join(f.out,'keep'),'utf8'),'untouched');
});

test('CLI stdout discloses counts and hashes but no operator object names or rule contents',t=>{
  const f=fixture(t),objectsFile=join(f.root,'objects.json'),base=join(f.root,'base.json');
  writeFileSync(objectsFile,JSON.stringify(['synthetic-private-object']));writeFileSync(base,JSON.stringify({synthetic_private_rule:true}));
  const p=spawnSync(process.execPath,[fileURLToPath(new URL('./build-bundle.mjs',import.meta.url)),'--repo',f.repo,'--commit',f.commit,'--out',f.out,'--installer',f.installer,'--observer',f.observer,'--objects-file',objectsFile,'--base-hub-contract',base],{encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout);assert.equal(result.object_count,1);assert.deepEqual(result.missing_requirements,[]);
  assert.ok(!p.stdout.includes('synthetic-private-object'));assert.ok(!p.stdout.includes('synthetic_private_rule'));assert.ok(!p.stdout.includes(f.root));
});
