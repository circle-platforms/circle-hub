import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Database} from './db.ts';
import {retirePersonalCaches} from './personal-caches.ts';

const owner='synthetic-owner',digest='a'.repeat(64);
const database={query:async(sql:string)=>sql.includes('personal.pack.digest')&&sql.includes('UNION SELECT owner')?{rows:[{value:owner+'/'+digest}],rowCount:1}:{rows:[],rowCount:0}} as unknown as Database;

test('cache retirement accepts staging removed after lstat but before chmod',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'circle-hub-cache-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const target=join(root,'.tmp-'+digest+'-synthetic');await fs.mkdir(target);await fs.writeFile(join(target,'file.txt'),'synthetic pack');await fs.chmod(target,0o500);
 const chmod=fs.chmod;let removed=false;
 const mocked=t.mock.method(fs,'chmod',async(path:Parameters<typeof fs.chmod>[0],mode:Parameters<typeof fs.chmod>[1])=>{
  if(String(path)===target&&!removed){removed=true;await chmod(target,0o700);await fs.rm(target,{recursive:true,force:true});}
  return chmod(path,mode);
 });
 syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
 await retirePersonalCaches(database,owner,new Set([root]),new Set());
 assert.equal(removed,true);assert.deepEqual(await fs.readdir(root),[]);
});

test('cache retirement accepts a root removed before its durability sync',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'circle-hub-cache-sync-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const open=fs.open;let removed=false;
 const mocked=t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  if(String(args[0])===root&&!removed){removed=true;await fs.rm(root,{recursive:true,force:true});}
  return open(...args);
 });
 syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
 await retirePersonalCaches(database,owner,new Set([root]),new Set());assert.equal(removed,true);
});

test('cache retirement still reports a permission failure',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'circle-hub-cache-permission-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const target=join(root,'.tmp-'+digest+'-synthetic');await fs.mkdir(target);
 const chmod=fs.chmod;
 const mocked=t.mock.method(fs,'chmod',async(path:Parameters<typeof fs.chmod>[0],mode:Parameters<typeof fs.chmod>[1])=>{
  if(String(path)===target)throw Object.assign(new Error('synthetic permission failure'),{code:'EACCES'});
  return chmod(path,mode);
 });
 syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
 await assert.rejects(retirePersonalCaches(database,owner,new Set([root]),new Set()),{code:'EACCES'});
});
