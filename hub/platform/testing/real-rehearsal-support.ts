// Disabled WIP retained for review. The supported direction is the dedicated plain VM; no real-data action is enabled.
// A capability exists only during a freshly passed synthetic Hub proof; plaintext remains inside its enclosure.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {constants,type Stats} from 'node:fs';
import {chmod,chown,lstat,mkdir,open,readFile,readdir,realpath,rm,rmdir,stat,statfs,writeFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import type {Readable,Writable} from 'node:stream';
import {createServer,createConnection} from 'node:net';
import {runCommand} from '../process.ts';
import {assertLiveEnclosure,assertSameIdentity,parseMountInfo,sourceMountReceipt,trustedRootMount,verifyMountTable,type MountReceipt,type VerifiedEnclosure} from './linux-rehearsal-isolation.ts';

export interface DestroyReceipt {unmounted:boolean;mappingClosed:boolean;loopDetached:boolean;imageRemoved:boolean}
export interface EncryptedVolume {readonly data:string;readonly mountReceipt:MountReceipt;readonly capacityBytes:number}
const activeVolumes=new WeakMap<EncryptedVolume,{context:VerifiedEnclosure;root:string;image:string;imageIdentity:Stats;dataIdentity:Stats;mapper:string;mapperIdentity:Stats;loop:string;loopIdentity:Stats}>();
const env={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'};
async function run(command:string,args:string[],timeoutMs=120_000):Promise<string>{const result=await runCommand(command,args,{env,timeoutMs});if(result.code!==0)throw new Error('演练平台动作失败（只报告退出码 '+result.code+'）');return result.stdout;}
async function requireUnswappableController():Promise<void>{
 const row=(await readFile('/proc/self/cgroup','utf8')).trim();if(!row.startsWith('0::/')||row.includes('\n')||row.includes('..'))throw new Error('真实演练控制器需要可核对的cgroup v2');
 const group='/sys/fs/cgroup'+row.slice(3);assert.equal((await readFile(group+'/memory.swap.max','utf8')).trim(),'0','控制器必须禁用swap');
 const limit=(await readFile(group+'/memory.max','utf8')).trim();assert.ok(/^\d+$/.test(limit)&&BigInt(limit)<=4n*1024n**3n,'控制器必须有不超过4GiB的内存上限');
 assert.match(await readFile('/proc/self/status','utf8'),/^VmSwap:\s+0\s+kB$/m);
}
async function checkLoop(loop:string,image:string,identity:Stats):Promise<void>{
 assert.match(loop,/^\/dev\/loop\d+$/);assertSameIdentity(await lstat(image),identity);
 const info=JSON.parse(await run('/usr/sbin/losetup',['--json','--output','NAME,BACK-FILE',loop]));assert.equal(info.loopdevices?.length,1);assert.equal(info.loopdevices[0].name,loop);assert.equal(info.loopdevices[0]['back-file'],image);
}
async function checkMapper(name:string,identity:Stats,loop:string):Promise<void>{
 assertSameIdentity(await stat('/dev/mapper/'+name),identity);const actual=await realpath('/dev/mapper/'+name),device=basename(actual);
 assert.equal((await readFile('/sys/block/'+device+'/dm/name','utf8')).trim(),name);assert.deepEqual(await readdir('/sys/block/'+device+'/slaves'),[basename(loop)]);
}
export async function assertLiveVolume(volume:EncryptedVolume,context:VerifiedEnclosure):Promise<void>{
 assertLiveEnclosure(context);const own=activeVolumes.get(volume);if(!own||own.context!==context)throw new Error('真实卷缺少本次创建能力');
 await checkLoop(own.loop,own.image,own.imageIdentity);assertSameIdentity(await stat(own.loop),own.loopIdentity);await checkMapper(own.mapper,own.mapperIdentity,own.loop);assertSameIdentity(await lstat(volume.data),own.dataIdentity);
 const matches=parseMountInfo(await readFile('/proc/self/mountinfo','utf8')).filter(row=>row.target===volume.data);assert.equal(matches.length,1);assert.equal(matches[0]!.device,volume.mountReceipt.device);assert.equal(matches[0]!.root,'/');assert.equal(matches[0]!.fs,'ext4');
}
/** 24GiB is reserved before receipt; no real bytes enter before mount, capacity and independent kernel identities pass. */
export async function withEncryptedRehearsalVolume<T>(context:VerifiedEnclosure,use:(volume:EncryptedVolume)=>Promise<T>):Promise<{result:T;destroyed:DestroyReceipt}>{
 throw new Error('WIP wrapper disabled: use the dedicated plain VM path');
 assertLiveEnclosure(context);await requireUnswappableController();
 const capacityBytes=24*1024**3,root='/var/tmp/chvm-real-'+randomBytes(6).toString('hex'),image=join(root,'image'),data=join(root,'data'),mapper=basename(root);
 const baseline=trustedRootMount(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')));sourceMountReceipt(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')),root,root,baseline);
 const free=await statfs('/var/tmp');assert.ok(Number(free.bavail)*Number(free.bsize)>=capacityBytes+8*1024**3,'真实卷与VM保留空间不足');
 let rootIdentity:Stats|undefined,imageIdentity:Stats|undefined,loopIdentity:Stats|undefined,mapperIdentity:Stats|undefined,dataIdentity:Stats|undefined,loop:string|undefined,volume:EncryptedVolume|undefined;
 let mounted=false,mappingOpened=false,loopAttempted=false,mappingAttempted=false;const destroyed:DestroyReceipt={unmounted:false,mappingClosed:false,loopDetached:false,imageRemoved:false};let result:T|undefined;let failure:unknown;
 try{
  await mkdir(root,{mode:0o700});rootIdentity=await lstat(root);await mkdir(data,{mode:0o700});
  const file=await open(image,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);imageIdentity=await file.stat();await file.close();
  await run('/usr/bin/fallocate',['--length',String(capacityBytes),image]);assertSameIdentity(await lstat(image),imageIdentity);assert.equal((await lstat(image)).size,capacityBytes);assert.ok((await lstat(image)).blocks*512>=capacityBytes,'镜像未完成物理空间预留');
  loopAttempted=true;loop=(await run('/usr/sbin/losetup',['--find','--show','--nooverlap',image])).trim();await checkLoop(loop,image,imageIdentity);loopIdentity=await stat(loop);
  // The random dm-crypt key is stdin-only, never argv/env/log/file, and is erased only after cryptsetup consumes it.
  mappingAttempted=true;const key=randomBytes(64);try{
   const child=spawn('/usr/sbin/cryptsetup',['open','--type','plain','--cipher','aes-xts-plain64','--key-size','512','--key-file','-','--keyfile-size','64',loop,mapper],{env,stdio:['pipe','ignore','ignore']});
   const timer=setTimeout(()=>child.kill('SIGKILL'),30_000);const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);child.stdin.on('error',()=>{});child.stdin.end(key);}).finally(()=>clearTimeout(timer));assert.equal(code,0);mappingOpened=true;
  }finally{key.fill(0);}
  mapperIdentity=await stat('/dev/mapper/'+mapper);await checkMapper(mapper,mapperIdentity,loop);await run('/usr/sbin/mkfs.ext4',['-q','-F','/dev/mapper/'+mapper]);
  await run('/usr/bin/mount',['-o','nodev,nosuid','/dev/mapper/'+mapper,data]);mounted=true;dataIdentity=await lstat(data);
  const rows=parseMountInfo(await readFile('/proc/self/mountinfo','utf8')).filter(row=>row.target===data);assert.equal(rows.length,1);assert.equal(rows[0]!.fs,'ext4');assert.equal(rows[0]!.root,'/');assert.deepEqual(await readdir(data),['lost+found']);
  await chown(data,context.uid,context.gid);await chmod(data,0o700);dataIdentity={...dataIdentity,uid:context.uid,gid:context.gid,mode:(dataIdentity.mode&~0o777)|0o700} as Stats;
  const space=await statfs(data);const available=Number(space.bavail)*Number(space.bsize);assert.ok(available>=20*1024**3&&Number(space.blocks)*Number(space.bsize)<=capacityBytes,'格式化后容量不足或越界');
  volume=Object.freeze({data,capacityBytes,mountReceipt:{target:'/data',device:rows[0]!.device,root:'/',fs:'ext4'}});activeVolumes.set(volume,{context,root,image,imageIdentity,dataIdentity,mapper,mapperIdentity,loop,loopIdentity});await assertLiveVolume(volume,context);
  result=await use(volume);
 }catch(error){failure=error;}
 finally{
  if(volume)activeVolumes.delete(volume);
  // No lazy unmount or name-only close: uncertainty retains encrypted isolation and is reported as incomplete destruction.
  try{
   if((loopAttempted&&!loop)||(mappingAttempted&&!mappingOpened))throw new Error('块设备创建状态未知，保留本次隔离');
   if(mounted){assert.ok(dataIdentity);assertSameIdentity(await lstat(data),dataIdentity);await run('/usr/bin/umount',[data]);destroyed.unmounted=true;}else destroyed.unmounted=true;
   if(mappingOpened){assert.ok(mapperIdentity&&loop);await checkMapper(mapper,mapperIdentity,loop);await run('/usr/sbin/cryptsetup',['close',mapper]);destroyed.mappingClosed=true;}else destroyed.mappingClosed=true;
   if(loop){assert.ok(imageIdentity&&loopIdentity);assertSameIdentity(await stat(loop),loopIdentity);await checkLoop(loop,image,imageIdentity);await run('/usr/sbin/losetup',['--detach',loop]);destroyed.loopDetached=true;}else destroyed.loopDetached=true;
   if(imageIdentity){assertSameIdentity(await lstat(image),imageIdentity);await rm(image);}destroyed.imageRemoved=true;
   if(rootIdentity){assertSameIdentity(await lstat(root),rootIdentity);await rmdir(data);await rmdir(root);}
  }catch{throw new Error('演练资料销毁未完成：'+JSON.stringify(destroyed)+'；保留加密隔离，禁止后续动作');}
 }
 if(failure)throw new Error('真实演练失败；已销毁本次加密卷：'+JSON.stringify(destroyed));
 return {result:result as T,destroyed};
}

export interface ReceiverProcess {readonly input:Writable;readonly output:Readable;readonly ready:Promise<void>;readonly completed:Promise<number>;cancel():Promise<void>}
/** Launches a receiver but does not expose stdin until real PID/mount/cgroup verification has completed. */
export async function startVerifiedReceiver(input:{context:VerifiedEnclosure;volume:EncryptedVolume;args:string[];env:NodeJS.ProcessEnv;expected:MountReceipt[];root:string;namespace:string;uid:number;data:string;assertLive:()=>Promise<void>}):Promise<ReceiverProcess>{
 throw new Error('WIP wrapper disabled: use the dedicated plain VM path');
 assertLiveEnclosure(input.context);await assertLiveVolume(input.volume,input.context);assert.equal(input.root,input.context.root);assert.equal(input.namespace,input.context.namespace);assert.equal(input.uid,input.context.uid);assert.equal(input.data,input.volume.data);
 await input.assertLive();assert.ok(input.args.at(-2)==='-e');const delimiter=input.args.indexOf('--');assert.deepEqual(input.args.slice(delimiter+1,delimiter+4),['/runtime/node','--input-type=module','-e']);assert.ok(input.args.includes('RootDirectory='+input.context.root)&&input.args.includes('BindPaths='+input.volume.data+':/data'));const nonce=randomBytes(12).toString('hex'),readyFile=join(input.data,'ready-'+nonce),goFile=join(input.data,'go-'+nonce);
 const prefix=`const _r=await import('node:fs/promises');await _r.writeFile('/data/ready-${nonce}',JSON.stringify({pid:process.pid,invocation:process.env.INVOCATION_ID,cgroup:await _r.readFile('/proc/self/cgroup','utf8')}),{flag:'wx'});let _go=false;for(let i=0;i<300;i++){try{await _r.access('/data/go-${nonce}');_go=true;break;}catch{}await new Promise(r=>setTimeout(r,100));}if(!_go)throw Error('receiver not verified');`;
 const args=[...input.args];args[args.length-1]=prefix+args.at(-1)!;const unit=args.find(arg=>arg.startsWith('--unit='))!.slice(7);
 const child=spawn('/usr/bin/systemd-run',args,{env:input.env,stdio:['pipe','pipe','ignore']});let spawnFailed=false;child.once('error',()=>{spawnFailed=true;});const completed=new Promise<number>(resolve=>{child.once('error',()=>resolve(-1));child.once('close',code=>resolve(code??-1));});
 let invocation:string|undefined;const ready=(async()=>{
  let record:{pid:number;invocation:string;cgroup:string}|undefined;for(let n=0;n<200;n++){if(spawnFailed||child.exitCode!==null)throw Error('receiver did not launch');try{record=JSON.parse(await readFile(readyFile,'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,100));}
  if(!record||!Number.isSafeInteger(record.pid)||! /^[a-f0-9]{32}$/.test(record.invocation))throw Error('receiver has no kernel receipt');invocation=record.invocation;await input.assertLive();
  assert.equal((await stat('/proc/'+record.pid+'/root')).ino,(await stat(input.root)).ino);assert.equal((await stat('/proc/'+record.pid+'/ns/net')).ino,(await stat('/run/netns/'+input.namespace)).ino);
  const status=await readFile('/proc/'+record.pid+'/status','utf8');assert.ok(status.split('\n').some(line=>line.startsWith('Uid:')&&line.split(/\s+/).slice(1).every(value=>Number(value)===input.uid)));assert.match(status,/^CapEff:\s+0+$/m);
  verifyMountTable(parseMountInfo(await readFile('/proc/'+record.pid+'/mountinfo','utf8')),input.expected);
  const group='/system.slice/'+unit+'.service';assert.equal(record.cgroup.trim(),'0::'+group);const cg='/sys/fs/cgroup'+group;assert.equal((await readFile(cg+'/memory.max','utf8')).trim(),String(4*1024**3));assert.equal((await readFile(cg+'/memory.swap.max','utf8')).trim(),'0');assert.equal((await readFile(cg+'/pids.max','utf8')).trim(),'128');await writeFile(goFile,'verified',{flag:'wx',mode:0o644});
 })();
 const cancel=async()=>{child.stdin.destroy();if(child.exitCode!==null||child.signalCode!==null)return;if(!invocation){await completed;return;}const current=(await run('/usr/bin/systemctl',['show',unit,'--property=InvocationID','--value'])).trim();if(current!==invocation)throw Error('receiver unit identity changed; refusing name-only stop');await run('/usr/bin/systemctl',['stop',unit]);await completed;};
 try{await ready;}catch{await cancel();throw new Error('接收端物理隔离/预算未知，未放行真实输入');}
 return {input:child.stdin,output:child.stdout,ready,completed,cancel};
}

/** The receive step reads real archive bytes only after the enclosing kernel/cgroup handshake, inside encrypted /data. */
export function backupReceiverProgram(maxBytes=8*1024**3):string{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024**3)throw new Error('接收预算不合法');
 return `import assert from 'node:assert/strict';import {mkdir,stat} from 'node:fs/promises';import {spawn} from 'node:child_process';import {Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';import {createHash} from 'node:crypto';
 const release='/release',api=await import(release+'/hub/platform/api.ts'),settings=await import(release+'/hub/platform/settings.ts');let pg;
 try{
  await mkdir('/data/incoming',{mode:0o700});let bytes=0;const hash=createHash('sha256');
  const count=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;if(bytes>${maxBytes})return done(Error('archive cap exceeded'));hash.update(chunk);done(null,chunk);}});
  const tar=spawn('/runtime/tar',['--extract','--file=-','--directory=/data/incoming','--no-same-owner','--no-same-permissions','--no-overwrite-dir'],{env:{PATH:'/runtime:/bin',HOME:'/data/home',TMPDIR:'/data/tmp',LANG:'C'},stdio:['pipe','ignore','ignore']});const ended=new Promise((resolve,reject)=>{tar.once('error',reject);tar.once('close',resolve)});
  await pipeline(process.stdin,count,tar.stdin);assert.equal(await ended,0);const manifest=await api.verifyBackup('/data/incoming');assert.equal(manifest.schema,'circle-hub-backup@3');assert.ok(manifest.files.every(f=>f.path==='database.dump'||/^(objects|vault|config)\\//.test(f.path)));
  const root=api.layoutAt('/data/target');await api.ensureLayout(root);const file=settings.newSettingsFile({environment:'test',port:18420,listenHost:'127.0.0.1',allowedHosts:['127.0.0.1'],keychainService:'isolated-real-rehearsal',database:{name:manifest.database.name,role:manifest.database.application_role.name}});await settings.writeSettingsFile(root,file);
  pg=api.createPostgres({layout:root,binariesRoot:release});const report=await api.restoreBackup({layout:root,backupDir:'/data/incoming',postgres:pg,libpqBin:'/runtime'});await pg.stop();pg=undefined;
  process.stdout.write(JSON.stringify({schema:'circle-hub-rehearsal-action@1',action:'backup',ok:true,bytes,sha256:hash.digest('hex'),tables:report.tables,rows:report.rows,vaultFiles:manifest.files.filter(f=>f.path.startsWith('vault/')).length})+'\\n');
 }catch{process.exitCode=1;}finally{if(pg)try{await pg.stop()}catch{process.exitCode=1}}`;
}
export function keyReceiverProgram():string{
 return `import {spawn} from 'node:child_process';const child=spawn('/runtime/node',['/release/bin/circle-hub','key','import'],{env:{PATH:'/runtime:/bin:/usr/bin',HOME:'/data/home',TMPDIR:'/data/tmp',CIRCLE_HUB_DATA_DIR:'/data/target',LANG:'C'},stdio:['pipe','ignore','ignore']});child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin);const code=await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('close',resolve)});if(code!==0)process.exitCode=1;else process.stdout.write(JSON.stringify({schema:'circle-hub-rehearsal-action@1',action:'key',ok:true})+'\\n');`;
}
/** Reports storage/transport facts only. No business read/run is performed and no body or credential is printed. */
export function verificationProgram():string{
 return `import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {readFile} from 'node:fs/promises';const release='/release',api=await import(release+'/hub/platform/api.ts');const root=api.layoutAt('/data/target');const env={PATH:'/runtime:/bin:/usr/bin',HOME:'/data/home',TMPDIR:'/data/tmp',LANG:'C',CIRCLE_HUB_DATA_DIR:root.root};const pg=api.createPostgres({layout:root,binariesRoot:release});let hub;
 const run=async args=>{const result=await api.runCommand('/runtime/node',[release+'/bin/circle-hub',...args],{env,timeoutMs:120000});assert.equal(result.code,0);return result.stdout;};
 try{await api.ensureDatabaseRunning(pg);await run(['operator-token','reissue']);await run(['records','verify','--vault']);
 const file=await api.readSettingsFile(root);assert.equal(file.listen_host,'127.0.0.1');assert.deepEqual(file.allowed_hosts,['127.0.0.1']);
 hub=spawn('/runtime/node',[release+'/bin/circle-hub','serve'],{env,stdio:'ignore'});let spawnFailed=false;hub.once('error',()=>{spawnFailed=true});let healthy=false;for(let n=0;n<100;n++){if(spawnFailed||hub.exitCode!==null||hub.signalCode!==null)throw Error('Hub startup failed');try{const r=await fetch('http://127.0.0.1:18420/healthz',{signal:AbortSignal.timeout(500)});if(r.ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}assert.ok(healthy);
 const store=api.fileKeyStore({root:root.root,service:file.keychain_service,account:'operator-token',item:api.OPERATOR_TOKEN_ITEM});const bytes=await store.read();let token;try{token=Buffer.from(bytes).toString('base64url')}finally{bytes.fill(0)};
 const rpc=async method=>{const r=await fetch('http://127.0.0.1:18420/mcp',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'isolated-storage-rehearsal',version:'1'}}:{}})});assert.equal(r.status,200);const text=await r.text(),event=text.split('\\n').find(line=>line.startsWith('data:'));const message=JSON.parse(event?event.slice(5):text);assert.equal(message.error,undefined);return message.result;};assert.equal((await rpc('initialize')).serverInfo.name,'circle-hub');assert.equal((await rpc('tools/list')).tools.length,6);
 process.stdout.write(JSON.stringify({schema:'circle-hub-rehearsal-action@1',action:'verify',ok:true,vaultOpened:true,mcpInitialized:true,businessOutcome:'unknown'})+'\\n');
 }catch{process.exitCode=1;}finally{if(hub&&hub.exitCode===null&&hub.signalCode===null){const closed=new Promise(r=>hub.once('close',r));hub.kill('SIGTERM');let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('stop timeout')),15000)})])}catch{process.exitCode=1}finally{clearTimeout(timer)}}try{await pg.stop()}catch{process.exitCode=1}}`;
}

/** Only factories below can create producer commands. Master-key values never enter this API. */
export interface SourceLocation {node:string;cli:string;dataDir:string;home:string;user:string;path:string;libpqBin?:string}
interface Producer {kind:'backup'|'key';command:string;args:readonly string[];env:NodeJS.ProcessEnv}
const producers=new WeakSet<object>();
export function platformProducer(kind:'backup'|'key',source:SourceLocation):Producer{
 if(kind!=='backup'&&kind!=='key')throw new Error('未知平台生产者类别');
 for(const value of [source.node,source.cli,source.dataDir,source.home])if(!value.startsWith('/')||/[\0\n\r]/.test(value))throw new Error('平台命令路径无效');
 const env:NodeJS.ProcessEnv={PATH:source.path,HOME:source.home,USER:source.user,LANG:'C',LC_ALL:'C',CIRCLE_HUB_DATA_DIR:source.dataDir,...(source.libpqBin?{CIRCLE_HUB_LIBPQ_BIN:source.libpqBin}:{})};
 // The backup producer calls the actual platform operation without retention pruning, then streams only its verified @3.
 const code=`import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';const api=await import(new URL('../hub/platform/api.ts',pathToFileURL(${JSON.stringify(source.cli)})).href);if(api.BACKUP_SCHEMA!=='circle-hub-backup@3')throw Error('unsupported source format');const context=api.createContext(process.env);const release=await api.readCurrentRelease(context.layout);const pg=api.postgresFor(context,release?.dir);const backup=await api.createBackup({layout:context.layout,postgres:pg,libpqBin:context.libpqBin});if(backup.skipped.length)throw Error('source evidence incomplete');await api.verifyBackup(backup.dir);const child=spawn('/usr/bin/tar',['--create','--file=-','--directory',backup.dir,'.'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','ignore']});child.stdout.pipe(process.stdout);process.exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('close',code=>resolve(code??1))});`;
 const producer=Object.freeze({kind,command:source.node,args:Object.freeze(kind==='key'?[source.cli,'key','export','--confirm']:['--input-type=module','-e',code]),env:Object.freeze(env)});producers.add(producer);return producer;
}
export interface ReceiverCommand {command:string;args:readonly string[];env:NodeJS.ProcessEnv}
const vmReceivers=new WeakSet<object>();
/** The channel is fixed to the dedicated VM alias; arbitrary executables/endpoints cannot trigger source export. */
export function vmReceiverCommand(endpoint:ReplayEndpoint,options:{node:string;home:string;user:string;path:string;agentSocket?:string}):ReceiverCommand{
 if(endpoint.schema!=='circle-hub-rehearsal-endpoint@1'||! /^[a-f0-9]{32}$/.test(endpoint.nonce)||!['backup','key'].includes(endpoint.action)||!/^\/var\/tmp\/chvm-real-[a-f0-9]{12}\/(backup|key)\.sock$/.test(endpoint.socket)||!/^\/var\/tmp\/chvm-build-[a-f0-9]{12}\/release\/hub\/platform\/testing\/real-rehearsal-support\.ts$/.test(endpoint.forwardScript)||!/^\/(usr|opt)\/[A-Za-z0-9_./-]*node$/.test(options.node))throw new Error('不是固定VM演练通道');
 const unit='chvm-forward-'+endpoint.nonce;
 const command=Object.freeze({command:'/usr/bin/ssh',args:Object.freeze(['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','root@hublinux','/usr/bin/systemd-run','--quiet','--pipe','--wait','--collect','--unit='+unit,'--property=MemoryMax=1G','--property=MemorySwapMax=0','--property=TasksMax=32','--property=RuntimeMaxSec=1800s','--setenv=CIRCLE_HUB_TEST_ISOLATION_VM=synthetic-only',options.node,endpoint.forwardScript,'forward',endpoint.socket]),env:Object.freeze({HOME:options.home,USER:options.user,PATH:options.path,LANG:'C',LC_ALL:'C',...(options.agentSocket?{SSH_AUTH_SOCK:options.agentSocket}:{})})});vmReceivers.add(command);return command;
}
/** A receiver announces verified readiness before the source process is started; both exits and timeout are mandatory. */
export async function pipePlatformProducer(producer:Producer,receiver:ReceiverCommand,expectedNonce:string,timeoutMs=1_800_000):Promise<{sourceExit:0;receiverExit:0}>{
 throw new Error('WIP wrapper disabled: use the dedicated plain VM path');
 if(!producers.has(producer)||!vmReceivers.has(receiver)||! /^[a-f0-9]{32}$/.test(expectedNonce)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>1_800_000)throw new Error('未固定平台生产者或接收端收据');
 const target=spawn(receiver.command,[...receiver.args],{env:receiver.env,stdio:['pipe','pipe','ignore']});let source:ChildProcess|undefined,failed=false;let timer:NodeJS.Timeout|undefined;
 const stop=()=>{if(source?.exitCode===null)source.kill('SIGKILL');if(target.exitCode===null)target.kill('SIGKILL');};
 const targetExit=new Promise<number>(resolve=>{target.once('error',()=>{failed=true;resolve(-1)});target.once('close',code=>resolve(code??-1));});
 try{
  await new Promise<void>((resolve,reject)=>{let text='';const onData=(chunk:Buffer)=>{text+=chunk.toString('utf8');if(Buffer.byteLength(text)>4096){reject(Error('oversized readiness'));return;}const newline=text.indexOf('\n');if(newline<0)return;target.stdout.off('data',onData);try{const ready=JSON.parse(text.slice(0,newline));assert.equal(ready.schema,'circle-hub-rehearsal-ready@1');assert.equal(ready.nonce,expectedNonce);assert.equal(ready.action,producer.kind);assert.equal(ready.ready,true);resolve();}catch{reject(Error('invalid readiness'));}};target.stdout.on('data',onData);target.once('error',()=>reject(Error('receiver unavailable')));target.once('close',()=>reject(Error('receiver closed before readiness')));timer=setTimeout(()=>reject(Error('receiver readiness deadline')),30_000);});
  clearTimeout(timer);target.stdout.resume(); // Never capture post-readiness output, including an accidental secret echo.
  source=spawn(producer.command,[...producer.args],{env:producer.env,stdio:['ignore','pipe','ignore']});source.stdout!.on('error',()=>{failed=true;stop()});target.stdin.on('error',()=>{failed=true;stop()});
  const sourceExit=new Promise<number>(resolve=>{source!.once('error',()=>{failed=true;stop();resolve(-1)});source!.once('close',code=>{if(code!==0){failed=true;stop()}resolve(code??-1)});});source.stdout!.pipe(target.stdin);
  timer=setTimeout(()=>{failed=true;stop()},timeoutMs);const [a,b]=await Promise.all([sourceExit,targetExit]);if(failed||a!==0||b!==0)throw Error('pipeline failed');return {sourceExit:0,receiverExit:0};
 }catch{throw new Error('平台双端管道未通过（不输出任何子进程内容），必须销毁本次接收卷');}
 finally{clearTimeout(timer);stop();target.stdin.destroy();target.stdout.destroy();}
}

export interface ReplayEndpoint {schema:'circle-hub-rehearsal-endpoint@1';action:'backup'|'key';socket:string;nonce:string;forwardScript:string}
/** Coordinates actual receiving only inside the live proof callback. The caller supplies the host-side platform producers. */
export async function serveRealReplay(context:VerifiedEnclosure,onEndpoint:(endpoint:ReplayEndpoint)=>Promise<void>):Promise<{result:{backup:Record<string,unknown>;verified:Record<string,unknown>};destroyed:DestroyReceipt}>{
 throw new Error('WIP wrapper disabled: use the dedicated plain VM path');
 assertLiveEnclosure(context);
 return withEncryptedRehearsalVolume(context,async volume=>{
  const action=async(kind:'backup'|'key'|'verify',program:string):Promise<Record<string,unknown>>=>{
   await assertLiveVolume(volume,context);const receiver=await context.runReceiver(program,volume,kind);const connections=new Set<import('node:net').Socket>();let text='';let oversized=false;
   receiver.output.on('data',(chunk:Buffer)=>{if(Buffer.byteLength(text)+chunk.length>4096){oversized=true;void receiver.cancel();return;}text+=chunk.toString('utf8');});
   let server:ReturnType<typeof createServer>|undefined,socketIdentity:Stats|undefined;const path=join(dirname(volume.data),kind+'.sock');
   try{
    if(kind==='verify'){receiver.input.end();assert.equal(await receiver.completed,0);}else{
     const nonce=randomBytes(16).toString('hex');let accepted=false;
     const incoming=new Promise<void>((resolve,reject)=>{
      server=createServer({allowHalfOpen:true},socket=>{
       if(accepted){socket.destroy();return;}accepted=true;connections.add(socket);socket.once('close',()=>{connections.delete(socket);if(!socket.writableFinished){void receiver.cancel();reject(Error('transport closed early'));}});
       socket.once('error',()=>{void receiver.cancel();reject(Error('transport disconnected'));});
       socket.write(JSON.stringify({schema:'circle-hub-rehearsal-ready@1',action:kind,nonce,ready:true})+'\n');socket.pipe(receiver.input);
       void receiver.completed.then(code=>{socket.end(JSON.stringify({schema:'circle-hub-rehearsal-finished@1',action:kind,nonce,ok:code===0&&!oversized})+'\n');if(code===0&&!oversized)resolve();else reject(Error('receiver failed'));},reject);
      });server.once('error',reject);server.listen(path);
      // No source is advertised before the exact newly created socket ownership is checked.
     });
     void incoming.catch(()=>{}); // Retain the rejection for the awaited stage while avoiding an early unhandled rejection.
     // Wait for the exact socket inode, not an existence-only readiness claim.
     for(let n=0;n<100;n++){try{const info=await lstat(path);if(info.isSocket()){await chmod(path,0o600);socketIdentity=await lstat(path);break;}}catch{}await new Promise(resolve=>setTimeout(resolve,20));}
     assert.ok(socketIdentity?.isSocket()&&socketIdentity.uid===0&&(socketIdentity.mode&0o777)===0o600);
     let timer:NodeJS.Timeout|undefined;
     try{await onEndpoint({schema:'circle-hub-rehearsal-endpoint@1',action:kind,socket:path,nonce,forwardScript:join(context.release,'hub/platform/testing/real-rehearsal-support.ts')});await Promise.race([incoming,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('transport deadline')),1_800_000);})]);}
     finally{clearTimeout(timer);}
    }
    assert.equal(oversized,false);const report=JSON.parse(text.trim());assert.equal(report.schema,'circle-hub-rehearsal-action@1');assert.equal(report.action,kind);assert.equal(report.ok,true);return report;
   }finally{
    await receiver.cancel();
    for(const socket of connections)socket.destroy();
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    if(socketIdentity){const current=await lstat(path).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});if(current){assertSameIdentity(current,socketIdentity);await rm(path);}}
   }
  };
  const backup=await action('backup',backupReceiverProgram());await action('key',keyReceiverProgram());const verified=await action('verify',verificationProgram());return {backup,verified};
 });
}
/** VM root forwarder: it never interprets archive/key bytes; only bounded control responses are decoded. */
export async function forwardReplaySocket(path:string):Promise<void>{
 throw new Error('WIP wrapper disabled: use the dedicated plain VM path');
 if(process.platform!=='linux'||process.getuid?.()!==0||process.env.CIRCLE_HUB_TEST_ISOLATION_VM!=='synthetic-only')throw new Error('只允许显式VM管理员转发');
 const marker=await open('/run/circle-hub-synthetic-vm',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await marker.stat();assert.ok(info.isFile()&&info.uid===0&&info.nlink===1&&(info.mode&0o777)===0o644&&info.size===Buffer.byteLength('circle-hub-synthetic-only-v1\n'));assert.equal(await marker.readFile('utf8'),'circle-hub-synthetic-only-v1\n');}finally{await marker.close();}
 const detected=await runCommand('/usr/bin/systemd-detect-virt',['--vm','--quiet'],{env,timeoutMs:5000});assert.equal(detected.code,0);await requireUnswappableController();
 assert.match(path,/^\/var\/tmp\/chvm-real-[a-f0-9]{12}\/(backup|key)\.sock$/);assert.equal(await realpath(dirname(path)),dirname(path));const parent=await lstat(dirname(path));assert.equal(parent.uid,0);assert.equal(parent.mode&0o777,0o700);const info=await lstat(path);assert.ok(info.isSocket()&&info.uid===0&&(info.mode&0o777)===0o600);
 const socket=createConnection({path,allowHalfOpen:true});let pending='',ready=false,finished=false;const expected=basename(path,'.sock');
 await new Promise<void>((resolve,reject)=>{
  socket.once('error',reject);socket.once('connect',()=>{process.stdin.pipe(socket);});
  socket.on('data',(chunk:Buffer)=>{pending+=chunk.toString('utf8');if(Buffer.byteLength(pending)>8192){socket.destroy();reject(Error('oversized control response'));return;}let split:number;while((split=pending.indexOf('\n'))>=0){const line=pending.slice(0,split);pending=pending.slice(split+1);try{const message=JSON.parse(line);assert.equal(message.action,expected);assert.match(message.nonce,/^[a-f0-9]{32}$/);if(!ready){assert.equal(message.schema,'circle-hub-rehearsal-ready@1');assert.equal(message.ready,true);process.stdout.write(line+'\n');ready=true;}else{assert.equal(message.schema,'circle-hub-rehearsal-finished@1');assert.equal(message.ok,true);finished=true;}}catch{socket.destroy();reject(Error('invalid control response'));}}});
  socket.once('end',()=>{if(!ready||!finished)reject(Error('rehearsal transport incomplete'));else resolve();});
 });
}
if(import.meta.main){const [action,path,...extra]=process.argv.slice(2);if(action!=='forward'||!path||extra.length)throw new Error('用法：forward <本次VM演练socket>');try{await forwardReplaySocket(path);}catch{process.stderr.write('演练转发未通过；未显示接收内容\n');process.exitCode=1;}}
