import assert from 'node:assert/strict';
import {mkdtemp, chmod, lstat, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileKeyProvider, fileKeyStore} from './file-key.ts';
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

test('Linux platform dispatch uses systemd and private files even with an injected command runner', async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-linux-platform-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const layout=layoutAt(root);const calls:string[]=[];
 const context=createContext({}, {layout,platform:'linux',home:root,launchAgentsDir:join(root,'systemd'),runner:async(command)=>{calls.push(command);return {code:0,stdout:'LoadState=not-found\n',stderr:''};}});
 const settings=resolveSettings(newSettingsFile({environment:'test'}),{},layout);
 const store=keychainFor(context,settings);await store.init();assert.equal((await store.status()).present,true);
 assert.equal((await agentFor(context,settings).status()).loaded,false);assert.deepEqual(calls,['/usr/bin/systemctl']);
});
