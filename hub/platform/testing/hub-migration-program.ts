import assert from 'node:assert/strict';
import {parseMountInfo,verifyMountTable,type MountReceipt} from './linux-rehearsal-isolation.ts';
// The real Hub migration chain, executed only inside the already-proved root-managed synthetic VM unit.
export async function isolatedHubMigration(input:{uid:number;net:number;root:number;address:string}):Promise<void>{
 const {randomBytes}=await import('node:crypto');
 const {mkdir,writeFile,readdir,lstat,stat,readFile}=await import('node:fs/promises');const {spawn}=await import('node:child_process');const {join}=await import('node:path');
 const release='/release';const platform=await import(release+'/hub/platform/api.ts');const settings=await import(release+'/hub/platform/settings.ts');
 const {pipeSyntheticKey}=await import(release+'/hub/platform/testing/linux-real-vm.ts');
 assert.equal(process.getuid?.(),input.uid);assert.notEqual(input.uid,0);assert.equal((await stat('/proc/self/ns/net')).ino,input.net);assert.equal((await stat('/')).ino,input.root);
 // These paths are generated here, not accepted as inputs; no real backup or key can enter this chain.
 await mkdir('/data/migration',{mode:0o700});const layouts=[platform.layoutAt('/data/migration/s'),platform.layoutAt('/data/migration/t')];
 const cluster:any[]=[],hub:ReturnType<typeof spawn>[]=[],definitions:any[]=[],envs:NodeJS.ProcessEnv[]=[];
 let step='source-init';let failed=false;
 const command=async(i:number,args:string[],value?:string)=>{
  const result=await platform.runCommand('/runtime/node',[release+'/bin/circle-hub',...args],{env:envs[i],input:value,timeoutMs:60_000});
  if(result.code!==0)throw new Error('isolated synthetic CLI failed: '+step);return result.stdout as string;
 };
 const port=async()=>{const {createServer}=await import('node:net');const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;};
 const ports=[await port(),await port()];assert.notEqual(ports[0],ports[1]);
 const verifyPid=async(pid:number)=>{assert.equal((await stat('/proc/'+pid+'/ns/net')).ino,input.net);assert.equal((await stat('/proc/'+pid+'/root')).ino,input.root);const status=await readFile('/proc/'+pid+'/status','utf8');assert.ok(status.split('\n').some(line=>line.startsWith('Uid:')&&line.split(/\s+/).slice(1).every(value=>Number(value)===input.uid)));};
 const stop=async(child:ReturnType<typeof spawn>)=>{if(child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.kill('SIGTERM');let timer:NodeJS.Timeout|undefined;try{await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('synthetic Hub stop deadline'));},15_000);})]);}finally{clearTimeout(timer);}};
 const token=async(i:number)=>{const store=platform.fileKeyStore({root:layouts[i].root,service:definitions[i].keychain_service,account:'operator-token',item:platform.OPERATOR_TOKEN_ITEM});const bytes=await store.read();try{return Buffer.from(bytes).toString('base64url');}finally{bytes.fill(0);}};
 const host=(i:number)=>i===0?'127.0.0.1':input.address;
 const rpc=async(i:number,method:string)=>{const response=await fetch('http://'+host(i)+':'+ports[i]+'/mcp',{method:'POST',signal:AbortSignal.timeout(10_000),headers:{Authorization:'Bearer '+await token(i),'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'isolated-synthetic-migration',version:'1'}}:{}})});assert.equal(response.status,200);const text=await response.text(),event=text.split('\n').find(line=>line.startsWith('data:'));const body=JSON.parse(event?event.slice(5):text);assert.equal(body.jsonrpc,'2.0');assert.equal(body.id,1);assert.equal(body.error,undefined);return body.result;};
 const launch=async(i:number)=>{
  const child=spawn('/runtime/node',[release+'/bin/circle-hub','serve'],{env:envs[i],stdio:'ignore'});hub.push(child);let spawnFailed=false;child.once('error',()=>{spawnFailed=true;});
  for(let attempt=0;attempt<100;attempt++){
   if(spawnFailed||child.exitCode!==null||child.signalCode!==null)throw new Error('real Hub startup failed inside preserved isolation: '+step);
   try{const response=await fetch('http://'+host(i)+':'+ports[i]+'/healthz',{signal:AbortSignal.timeout(500)});if(response.ok){const health=await response.json();assert.equal(health.status,'ok');assert.equal(health.release,JSON.parse(await readFile(release+'/release.json','utf8')).id);assert.ok(child.pid);await verifyPid(child.pid);return child;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,200));
  }throw new Error('real Hub startup deadline inside isolation: '+step);
 };
 try{
  for(let i=0;i<2;i++){
   await platform.ensureLayout(layouts[i]);const file=settings.newSettingsFile({environment:'test',port:ports[i],listenHost:host(i),allowedHosts:[host(i)],keychainService:'synthetic-'+randomBytes(6).toString('hex')});
   assert.equal(file.listen_host,host(i),'hub-listen must be present in pinned source');definitions.push(file);await settings.writeSettingsFile(layouts[i],file);
   envs.push({...platform.serviceEnvironment(layouts[i],settings.resolveSettings(file,{},layouts[i]),{home:'/data/home',user:(await import('node:os')).userInfo().username,database:settings.resolveSettings(file,{},layouts[i]).database}),PATH:'/runtime:/bin:/usr/bin',HOME:'/data/home',CIRCLE_HUB_LIBPQ_BIN:'/runtime'});
   cluster.push(platform.createPostgres({layout:layouts[i],binariesRoot:release}));const binaries=await cluster[i].binaries();
   assert.equal((await cluster[i].binaryVersion()).major,18);
   for(const file of Object.values(binaries) as string[]){const result=await platform.runCommand('/usr/bin/ldd',[file],{env:{PATH:'/runtime:/bin:/usr/bin',LANG:'C'},timeoutMs:10_000});assert.equal(result.code,0);assert.ok(!result.stdout.includes('not found'));}
  }
  await cluster[0].initialise();await platform.ensureDatabaseRunning(cluster[0],{create:true});await command(0,['serve','--migrate-only']);await command(0,['key','init']);await command(0,['init-admin','合成管理员']);
  for(let n=0;n<3;n++){
   step='synthetic-secret-'+n;const name='SYNTHETIC_VM_SECRET_'+n,call=(tool:string)=>({tool,arguments:{}});
   const definition={schema:'executor@1',enabled:true,environment:'test',target:'synthetic-'+n,endpoint:'http://127.0.0.1:1/mcp',ca:'',credential:'${secret:'+name+'}',max_run_ms:1000,payload_argument:'/blob',allowed_tools:['open','touch','close','inspect','submit','status','result'],calls:{acquire:call('open'),heartbeat:call('touch'),release:call('close'),precheck:call('inspect'),submit:{tool:'submit',arguments:{request:{$value:'request_id'},sequence:{$value:'dispatch_sequence'},scope:{$value:'sequence_scope'},blob:{$value:'payload_base64'}}},status:call('status'),result:call('result')},lease:{id:'/id',token:'/token',ttl_ms:'/ttl',acceptance:'/ok',map:{yes:'accepted'}},receipt:{acceptance:'/ok',map:{yes:'accepted'},id:'/id',sha256:'/sha',items:'/items'},status:{pointer:'/status',map:{}},result:{id:'/id',sha256:'/sha',submitted_at:'/at',items:'/items',item_id:'/id',item_outcome:'/outcome',complete:'/complete',map:{}},conditions:[],read_retry_when:[],proof:{package:'synthetic-workflow',manifest_sha256:'/manifest',requirement:'synthetic',slot:'synthetic',plan_run:'/run',sha256:'/sha',items:'/items',target:'/target',build:'/build',generator:'/generator'}};
   const path='/data/migration/executor-'+n+'.json';await writeFile(path,JSON.stringify(definition),{mode:0o600,flag:'wx'});await command(0,['executor','add',path]);await command(0,['secret','set','--name',name,'--reason','合成迁移验证'],randomBytes(48+n*24).toString('hex')+'\n');
  }
  step='source-vault-verify';assert.match(await command(0,['records','verify','--vault']),/已核验 3 条；异常 0 项/);
  step='source-real-Hub-MCP';const source=await launch(0);assert.equal((await rpc(0,'initialize')).serverInfo.name,'circle-hub');const sourcePg=await cluster[0].status();assert.ok(sourcePg.pid);await verifyPid(sourcePg.pid);
  step='backup@3';const backup=await platform.createBackup({layout:layouts[0],postgres:cluster[0],libpqBin:'/runtime'});const manifest=await platform.verifyBackup(backup.dir);assert.equal(manifest.schema,'circle-hub-backup@3');assert.equal(manifest.files.filter((file:any)=>file.path.startsWith('vault/')).length,3);assert.ok(manifest.files.every((file:any)=>file.path==='database.dump'||/^(objects|vault|config)\//.test(file.path)));assert.ok(manifest.database.tables.some((table:any)=>table.rows>0));
  step='freeze-source';await stop(source);await cluster[0].stop();assert.ok(source.exitCode!==null||source.signalCode!==null);await assert.rejects(fetch('http://127.0.0.1:'+ports[0]+'/healthz',{signal:AbortSignal.timeout(500)}));
  step='empty-root-restore';assert.deepEqual(await readdir(layouts[1].db),[]);assert.deepEqual(await readdir(layouts[1].vault),[]);await platform.restoreBackup({layout:layouts[1],backupDir:backup.dir,postgres:cluster[1],libpqBin:'/runtime'});const targetPg=await cluster[1].status();assert.ok(targetPg.pid);await verifyPid(targetPg.pid);
  step='synthetic-key-process-pipe';const pipe=(i:number,args:string[])=>({node:'/runtime/node',args:[release+'/bin/circle-hub',...args],env:envs[i],cwd:release});await pipeSyntheticKey(pipe(0,['key','export','--confirm']),pipe(1,['key','import']));await assert.rejects(pipeSyntheticKey(pipe(0,['key','export','--confirm']),pipe(1,['key','import'])));
  await command(1,['operator-token','reissue','--as','合成管理员']);assert.notEqual(await token(0),await token(1));
  for(const entry of await readdir(join(layouts[1].root,'keys'))){const info=await lstat(join(layouts[1].root,'keys',entry));assert.ok(info.isFile());assert.equal(info.uid,input.uid);assert.equal(info.mode&0o777,0o600);}
  step='target-vault-verify';assert.match(await command(1,['records','verify','--vault']),/已核验 3 条；异常 0 项/);
  step='target-real-Hub-MCP';await launch(1);const initialized=await rpc(1,'initialize');assert.equal(initialized.serverInfo.name,'circle-hub');assert.equal(initialized.protocolVersion,'2025-06-18');assert.equal((await rpc(1,'tools/list')).tools.length,6);
  for(const headers of [{Host:'not-authorized.invalid'},{Origin:'http://not-authorized.invalid'}] as Record<string,string>[]){const response=await fetch('http://'+input.address+':'+ports[1]+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+await token(1),'Content-Type':'application/json',...headers},body:'{}',signal:AbortSignal.timeout(3000)});assert.equal(response.status,403);}
  assert.ok(source.exitCode!==null||source.signalCode!==null);
 }catch{failed=true;throw new Error('isolated real Hub synthetic migration failed at '+step);}
 finally{let cleanupFailed=false;for(const child of hub.reverse())try{await stop(child);}catch{cleanupFailed=true;}for(const control of cluster.reverse())try{await control.stop();}catch{cleanupFailed=true;}if(cleanupFailed)throw new Error('isolated Hub/PG cleanup incomplete'+(failed?' after failure':''));}
}
export function hubMigrationProgram(input:{uid:number;net:number;root:number;address:string},mounts:MountReceipt[]):string{
 if(input.uid<1||input.address!=='192.0.2.1')throw new Error('Hub链仅接受专用非root身份与封闭namespace内合成地址');
 return `const assert=(await import('node:assert/strict')).default;const {readFile}=await import('node:fs/promises');const parse=${parseMountInfo.toString()};const verify=${verifyMountTable.toString()};verify(parse(await readFile('/proc/self/mountinfo','utf8')),${JSON.stringify(mounts)});await (${isolatedHubMigration.toString()})(${JSON.stringify(input)});process.stdout.write('isolated-real-Hub-migration-ok');`;
}
