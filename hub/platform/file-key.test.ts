import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, chmod, lstat, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileKeyProvider, fileKeyStore, removeKeyFile} from './file-key.ts';
import {VAULT_KEY_ITEM, OPERATOR_TOKEN_ITEM} from './keychain-items.ts';
import {agentFor, createContext, keychainFor} from './context.ts';
import {layoutAt} from './layout.ts';
import {newSettingsFile, resolveSettings} from './settings.ts';

test('Linux file keys remain private and separate, read exact bytes, and never replace existing items', async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-file-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const master=fileKeyStore({root,service:'synthetic',account:'vault',item:VAULT_KEY_ITEM});
 const operator=fileKeyStore({root,service:'synthetic',account:'operator-token',item:OPERATOR_TOKEN_ITEM});
 assert.deepEqual(await master.status(),{present:false});
 await assert.rejects(master.read(),/没有密钥库主密钥/);
 const value=Uint8Array.from({length:32},(_,i)=>i);await master.write(value);await operator.init();
 assert.deepEqual(await master.read(),value);assert.notDeepEqual(await operator.read(),value);
 const keys=join(root,'keys');assert.equal((await lstat(keys)).mode&0o777,0o700);
 const files=await readdir(keys);assert.equal(files.length,2);for(const file of files)assert.equal((await lstat(join(keys,file))).mode&0o777,0o600);
 await assert.rejects(master.write(Uint8Array.from(value)),/不覆盖/);
 const provider=fileKeyProvider({root,service:'synthetic',account:'vault'});assert.deepEqual(await provider.getKey(),value);
 const returned=await provider.getKey();returned.fill(0);assert.deepEqual(await provider.getKey(),value);
 assert.equal(await operator.delete(),true);assert.equal(await operator.delete(),false);assert.deepEqual(await master.read(),value);
});

test('Linux file keys refuse insecure permissions and symlinks rather than reading them', async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-file-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=fileKeyStore({root,service:'synthetic',account:'vault',item:VAULT_KEY_ITEM});await store.init();
 const keys=join(root,'keys');const [name]=await readdir(keys);const path=join(keys,name!);
 await chmod(path,0o644);await assert.rejects(store.read(),/权限/);await assert.rejects(store.status(),/权限/);
 await chmod(path,0o600);await rm(path);const other=join(root,'target');await writeFile(other,Buffer.alloc(32),{mode:0o600});await symlink(other,path);
 await assert.rejects(store.read(),/无法安全读取/);await assert.rejects(store.status(),/权限/);
 await rm(path);await chmod(keys,0o755);await assert.rejects(store.write(Buffer.alloc(32)),/0700/);
});

test('a substituted FIFO with no writer is rejected without blocking', {timeout:5000}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-file-fifo-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=fileKeyStore({root,service:'synthetic',account:'vault',item:VAULT_KEY_ITEM});await store.init();
 const keys=join(root,'keys');const [name]=await readdir(keys);const path=join(keys,name!);await rm(path);
 const fifo=spawnSync('/usr/bin/mkfifo',['-m','600',path],{encoding:'utf8',timeout:2000});
 assert.equal(fifo.error,undefined);assert.equal(fifo.status,0,fifo.stderr);
 const script=`const {fileKeyStore}=await import(process.argv[2]);try{await fileKeyStore({root:process.argv[1],service:'synthetic',account:'vault'}).read();process.exitCode=1;}catch(e){if(!String(e).includes('权限'))process.exitCode=2;}`;
 // A separate process imposes a hard deadline even if a regression strands a libuv worker in open().
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,root,new URL('./file-key.ts',import.meta.url).href],{encoding:'utf8',timeout:3000,env:{PATH:'/usr/bin:/bin',HOME:root}});
 assert.equal(child.error,undefined,'FIFO read must finish before the hard deadline');assert.equal(child.status,0,child.stderr);
});

test('Linux platform dispatch uses systemd and private files even with an injected command runner', async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-linux-platform-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const layout=layoutAt(root);const calls:string[]=[];
 const context=createContext({}, {layout,platform:'linux',home:root,launchAgentsDir:join(root,'systemd'),runner:async(command)=>{calls.push(command);return {code:0,stdout:'LoadState=not-found\n',stderr:''};}});
 const settings=resolveSettings(newSettingsFile({environment:'test'}),{},layout);
 const store=keychainFor(context,settings);await store.init();assert.equal((await store.status()).present,true);
 assert.equal((await agentFor(context,settings).status()).loaded,false);assert.deepEqual(calls,['/usr/bin/systemctl']);
});

test('Linux service defaults to the effective account home even when HOME is inherited from another account', async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-linux-home-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const previous=process.env.HOME;
 try {
  process.env.HOME=join(root,'wrong-home');
  const context=createContext({}, {layout:layoutAt(root),platform:'linux'});
  assert.equal(context.home,userInfo().homedir);
  assert.equal(context.launchAgentsDir,join(userInfo().homedir,'.config','systemd','user'));
 } finally { if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous; }
});

test('an interrupted key write cannot be used or overwritten and names a safe recovery action', async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-file-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=fileKeyStore({root,service:'synthetic',account:'vault',item:VAULT_KEY_ITEM});await store.init();
 const keys=join(root,'keys');const [name]=await readdir(keys);const path=join(keys,name!);
 await writeFile(path,Buffer.alloc(7));
 await assert.rejects(store.status(), (error: unknown) => /写入时中断/.test(String(error)) && /重新导入/.test((error as {hint?: string}).hint ?? ''));
 await assert.rejects(store.read(), /写入时中断/);
 await assert.rejects(store.write(Buffer.alloc(32)), /不覆盖/);
 await rename(path,join(root,'damaged-key'));
 await store.write(Buffer.alloc(32));assert.equal((await store.read()).length,32);
});

test('concurrent removal treats ENOENT as absent but does not hide other failures', async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-file-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=fileKeyStore({root,service:'synthetic',account:'vault',item:VAULT_KEY_ITEM});await store.init();
 const outcomes=await Promise.all([store.delete(),store.delete()]);
 assert.equal(outcomes.length,2);assert.ok(outcomes.some(Boolean));assert.equal((await store.status()).present,false);
 const missing=Object.assign(new Error('missing'),{code:'ENOENT'});
 assert.equal(await removeKeyFile('synthetic',async()=>{throw missing;}),false);
 const denied=Object.assign(new Error('denied'),{code:'EACCES'});
 await assert.rejects(removeKeyFile('synthetic',async()=>{throw denied;}),error=>error===denied);
 // A key file that is present but unsafe still fails delete: only a vanished file counts as removed by someone else.
 await store.init();
 const [file]=(await readdir(join(root,'keys'))).filter(name=>name.endsWith('.key'));
 await chmod(join(root,'keys',file!),0o644);
 await assert.rejects(store.delete(),/属主或权限不对/);
 assert.ok((await readdir(join(root,'keys'))).includes(file!));
});
