// Root-only synthetic VM isolation fixture. No backup, keychain or production deployment is accepted as input.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {constants,createReadStream,type Stats} from 'node:fs';
import {chmod, chown, lchown, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {runCommand} from '../process.ts';

const safePath = (path:string) => path.startsWith('/') && /^\/[A-Za-z0-9_./-]+$/.test(path) && resolve(path)===path;
export interface IsolationDefinition {unit:string; user:string; namespace:string; root:string; data:string; release:string; node:string}

/** Only a generated synthetic identity and simple absolute paths may enter systemd's property parser. */
export function isolatedUnitArguments(d:IsolationDefinition, programArgs:string[]):string[] {
  if(!/^chvm-[a-f0-9]{12}$/.test(d.user) || d.namespace!==d.user || ![d.user+'-probe',d.user+'-build'].includes(d.unit) || d.root!=='/var/tmp/'+d.user)throw new Error('隔离身份不属于本次合成命名空间');
  if(![d.root,d.data,d.release,d.node].every(safePath) || !/^\/var\/tmp\/chvm-build-[a-f0-9]{12}\/release$/.test(d.release))throw new Error('隔离路径不安全');
  if(d.data!==join(d.root,'data') || !programArgs.length || programArgs[0]!=='/runtime/node')throw new Error('隔离入口或数据根无效');
  const properties=[
    `User=${d.user}`,`Group=${d.user}`,`RootDirectory=${d.root}`,`NetworkNamespacePath=/run/netns/${d.namespace}`,
    'PrivateMounts=yes','PrivateDevices=yes','PrivateTmp=yes','ProtectSystem=strict','ProtectHome=yes',
    'ProtectProc=invisible','ProcSubset=pid','NoNewPrivileges=yes','CapabilityBoundingSet=',
    'AmbientCapabilities=','RestrictSUIDSGID=yes','RestrictNamespaces=yes','LockPersonality=yes',
    'ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectKernelLogs=yes','ProtectControlGroups=yes',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6','RemoveIPC=yes','UMask=0077','KillMode=control-group',
    'SendSIGKILL=yes','TimeoutStopSec=15s','RuntimeMaxSec=120s','Restart=no',
    `BindReadOnlyPaths=${d.node}:/runtime/node ${d.release}:/release /usr/lib /lib -/lib64 /var/tmp/chvm-host-${d.user.slice(5)}/visible:/sentinel/visible`,
    `BindPaths=${d.data}:/data`,'ReadWritePaths=/data','WorkingDirectory=/data',
    'InaccessiblePaths=-/mnt -/media -/Users -/Volumes -/host -/run/user',
  ];
  return ['--quiet','--wait','--pipe','--collect',`--unit=${d.unit}`,...properties.flatMap(property=>['--property',property]),
    '--setenv=HOME=/data/home','--setenv=PATH=/runtime','--setenv=LANG=C','--setenv=CIRCLE_HUB_DATA_DIR=/data',
    '--',...programArgs];
}

export interface MountRow {device:string; root:string; target:string; fs:string}
export interface MountReceipt {target:string; device:string; root:string; fs:string}
/** Parse kernel mountinfo, including escaped paths, without treating source text as a trusted mount label. */
export function parseMountInfo(text:string):MountRow[] {
  return text.trim().split('\n').filter(Boolean).map(line=>{
    const halves=line.split(' - '), left=halves[0]!.split(' '), right=halves[1]?.split(' ');
    if(halves.length!==2||left.length<6||!right||right.length<3)throw new Error('mountinfo 形状无效');
    const decode=(value:string)=>value.replace(/\\([0-7]{3})/g,(_match,octal:string)=>String.fromCharCode(parseInt(octal,8)));
    return {device:left[2]!,root:decode(left[3]!),target:decode(left[4]!),fs:right[0]!};
  });
}
/** Freeze an independent VM root-device baseline before constructing any release, data or service. */
export function trustedRootMount(rows:MountRow[]):MountRow {
  const roots=rows.filter(row=>row.target==='/');
  if(roots.length!==1||roots[0]!.root!=='/'||!['ext4','xfs','btrfs'].includes(roots[0]!.fs))throw new Error('VM 根挂载不是独立可核对的本地根文件系统');
  return {...roots[0]!};
}
/** Derive expected roots from a prior VM-root baseline, never from a covering source mount. */
export function sourceMountReceipt(rows:MountRow[],source:string,target:string,baseline:MountRow):MountReceipt {
  if(baseline.target!=='/'||baseline.root!=='/'||!['ext4','xfs','btrfs'].includes(baseline.fs))throw new Error('缺少可信 VM 根挂载基线');
  const current=trustedRootMount(rows);
  if(current.device!==baseline.device||current.fs!==baseline.fs)throw new Error('VM 根设备在预备后改变');
  const beneath=(path:string,parent:string)=>path===parent||path.startsWith(parent==='/'?'/':parent+'/');
  if(rows.some(row=>row.target!=='/'&&(beneath(source,row.target)||beneath(row.target,source))))throw new Error('绑定源本身、祖先或子树被额外挂载覆盖');
  if(!source.startsWith('/')||source.includes('/../')||source.includes('//'))throw new Error('绑定源路径不规范');
  return {target,device:baseline.device,root:source,fs:baseline.fs};
}
/** Every real filesystem mount must match its host-side receipt; unrecognized mounts fail closed. */
export function verifyMountTable(rows:MountRow[],expected:MountReceipt[]):void {
  for(const receipt of expected){
    const matches=rows.filter(row=>row.target===receipt.target);
    if(matches.length!==1||matches[0]!.device!==receipt.device||matches[0]!.root!==receipt.root||matches[0]!.fs!==receipt.fs)throw new Error('隔离挂载来源与收据不一致');
  }
  for(const row of rows){
    if(expected.some(receipt=>receipt.target===row.target))continue;
    const allowed:Record<string,string[]>={'/proc':['proc'],'/dev':['tmpfs'],'/dev/pts':['devpts'],'/dev/shm':['tmpfs'],'/tmp':['tmpfs'],'/var/tmp':['tmpfs'],'/run':['tmpfs']};
    const pseudo=row.root==='/'&&Boolean(allowed[row.target]?.includes(row.fs));
    if(!pseudo)throw new Error('隔离内出现未声明挂载');
  }
}
export function assertSameIdentity(current:{dev:number;ino:number;uid:number;mode:number},created:{dev:number;ino:number;uid:number;mode:number}):void {
  if(current.dev!==created.dev||current.ino!==created.ino||current.uid!==created.uid||current.mode!==created.mode)throw new Error('资源身份已改变');
}
export async function assertCanonicalPath(path:string):Promise<void>{
  if(!safePath(path)||await realpath(path)!==path)throw new Error('路径不规范或经过符号链接');
  let part='';for(const component of path.split('/').filter(Boolean)){part+='/'+component;const info=await lstat(part);if(info.isSymbolicLink())throw new Error('拒绝符号链接祖先');}
}
async function assertFrozenParents(path:string):Promise<void>{
  let part='';for(const component of path.split('/').filter(Boolean)){
    part+='/'+component;const info=await lstat(part);
    const privateTempParent=part==='/var/tmp'&&info.uid===0&&(info.mode&0o1000)!==0;
    if(info.uid!==0||((info.mode&0o022)!==0&&!privateTempParent))throw new Error('绑定源祖先可被非管理员改写');
  }
}
async function assertRootOwnedTree(root:string,base=root):Promise<void>{
  const parent=await lstat(root);if(parent.uid!==0||(parent.mode&0o022)!==0)throw new Error('发布根未由管理员冻结');
  for(const entry of await readdir(root,{withFileTypes:true})){
    const path=join(root,entry.name), info=await lstat(path);
    if(info.uid!==0||(!info.isSymbolicLink()&&(info.mode&0o022)!==0))throw new Error('发布树必须由管理员冻结且不可被其他账户改写');
    if(info.isSymbolicLink()){const target=await realpath(path);if(!target.startsWith(base+'/'))throw new Error('发布树符号链接越界');}
    else if(info.isDirectory())await assertRootOwnedTree(path,base);
    else if(!info.isFile())throw new Error('发布树含非普通文件');
  }
}
async function accountLine(path:string,name:string):Promise<string>{
  const rows=(await readFile(path,'utf8')).split('\n').filter(line=>line.startsWith(name+':'));
  if(rows.length!==1)throw new Error('账户身份缺失或重复');return rows[0]!;
}

async function rootVmGate():Promise<void> {
  if(process.platform!=='linux'||process.getuid?.()!==0||process.versions.node.split('.')[0]!=='24'||process.env.CIRCLE_HUB_TEST_ISOLATION_VM!=='synthetic-only')throw new Error('隔离夹具只允许显式授权 Linux VM 的 Node24 管理员');
  const marker=await open('/run/circle-hub-synthetic-vm',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=await marker.stat();assert.ok(info.isFile()&&info.uid===0&&info.nlink===1&&(info.mode&0o777)===0o644);assert.equal(await marker.readFile('utf8'),'circle-hub-synthetic-only-v1\n');}finally{await marker.close();}
  const detected=await runCommand('/usr/bin/systemd-detect-virt',['--vm','--quiet'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeoutMs:10_000});
  if(detected.code!==0)throw new Error('拒绝在未识别 VM 的主机创建隔离夹具');
}

interface OfflineManifest {schema:'circle-hub-offline-build@1';source_commit:string;node_sha256:string;files:Record<string,string>}
async function hashFile(path:string):Promise<string>{const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
export async function verifyOfflineBundle(path:string,pin:string):Promise<{path:string;manifest:OfflineManifest}>{
  if(!/^\/var\/tmp\/chvm-offline-[a-f0-9]{12}$/.test(path)||! /^[a-f0-9]{64}$/.test(pin))throw new Error('缺少预先固定的离线构建包和独立清单 SHA；不联网补齐');
  await assertCanonicalPath(path);await assertFrozenParents(path);await assertRootOwnedTree(path);
  if(((await lstat(path)).mode&0o005)!==0o005)throw new Error('离线包须对专用构建账户只读可遍历');
  const raw=await readFile(join(path,'manifest.json'));if(raw.length>1024*1024||createHash('sha256').update(raw).digest('hex')!==pin)throw new Error('离线清单 SHA 不符');
  const manifest=JSON.parse(raw.toString('utf8')) as OfflineManifest;
  if(manifest.schema!=='circle-hub-offline-build@1'||! /^[a-f0-9]{40}$/.test(manifest.source_commit)||! /^[a-f0-9]{64}$/.test(manifest.node_sha256)||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('离线构建清单形状无效');
  const found:string[]=[];
  const visit=async(directory:string)=>{for(const entry of await readdir(directory,{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('离线包不接受符号链接');const mode=(await lstat(file)).mode;if((mode&0o004)===0||(entry.isDirectory()&&(mode&0o001)===0))throw new Error('离线资产对非 root 构建账户不可读');if(entry.isDirectory())await visit(file);else if(entry.isFile())found.push(file.slice(path.length+1));else throw new Error('离线包含非普通文件');}};
  await visit(path);
  const declared=Object.keys(manifest.files).sort();
  if(!declared.includes('source.tar')||!declared.includes('npm/bin/npm-cli.js')||!declared.some(file=>file.startsWith('cache/'))||JSON.stringify(found.filter(file=>file!=='manifest.json').sort())!==JSON.stringify(declared))throw new Error('离线包文件集不闭合');
  for(const file of declared){if(!/^(source\.tar|npm\/[A-Za-z0-9_./@+-]+|cache\/[A-Za-z0-9_./@+-]+)$/.test(file)||file.split('/').includes('..')||! /^[a-f0-9]{64}$/.test(manifest.files[file]!))throw new Error('离线包文件声明不安全');if(await hashFile(join(path,file))!==manifest.files[file])throw new Error('离线包文件 SHA 不符');}
  return {path,manifest};
}
async function freezeBuiltTree(path:string,base=path):Promise<void>{
 const info=await lstat(path);if(info.isSymbolicLink()){const target=await realpath(path);if(!target.startsWith(base+'/'))throw new Error('构建输出链接越界');await lchown(path,0,0);return;}
 if(!info.isDirectory()&&!info.isFile())throw new Error('构建输出包含特殊文件');
 await chown(path,0,0);await chmod(path,info.isDirectory()?0o755:(info.mode&0o111)!==0?0o755:0o644);
 if(info.isDirectory())for(const entry of await readdir(path))await freezeBuiltTree(join(path,entry),base);
}
export function offlineBuildProgram(input:{uid:number;net:number;root:number;mounts:MountReceipt[];commit:string;host:string;port:number;malicious:boolean}):string{
 if(!Number.isSafeInteger(input.uid)||input.uid<1||! /^[a-f0-9]{40}$/.test(input.commit))throw new Error('离线构建必须使用专用非 root 身份和固定提交');
 return `import assert from 'node:assert/strict';import {cp,mkdir,readFile,writeFile,stat,chmod,readdir} from 'node:fs/promises';import {spawn} from 'node:child_process';
 const parse=${parseMountInfo.toString()};const verify=${verifyMountTable.toString()};
 assert.equal(process.getuid(),${input.uid});assert.notEqual(process.getuid(),0);assert.equal((await stat('/proc/self/ns/net')).ino,${input.net});assert.equal((await stat('/')).ino,${input.root});verify(parse(await readFile('/proc/self/mountinfo','utf8')),${JSON.stringify(input.mounts)});
 const run=(file,args,cwd)=>new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd,env:{HOME:'/data/home',PATH:'/runtime:/bin:/usr/bin',LANG:'C'},stdio:'ignore'});child.once('error',reject);child.once('exit',code=>resolve(code));});
 await mkdir('/data/source',{recursive:false});await cp('/offline/cache','/data/cache',{recursive:true});const writable=async(path)=>{const info=await stat(path);await chmod(path,info.isDirectory()?0o700:0o600);if(info.isDirectory())for(const name of await readdir(path))await writable(path+'/'+name)};await writable('/data/cache');
 assert.equal(await run('/runtime/tar',['--extract','--file=/offline/source.tar','--directory=/data/source','--no-same-owner','--no-same-permissions','--no-overwrite-dir'],'/data'),0);
 if(${input.malicious}){
  const attack="import assert from 'node:assert/strict';import {writeFile,stat} from 'node:fs/promises';import {connect} from 'node:net';assert.notEqual(process.getuid(),0);assert.equal((await stat('/proc/self/ns/net')).ino,${input.net});assert.equal((await stat('/')).ino,${input.root});await assert.rejects(writeFile('/sentinel/hidden','attack'));await assert.rejects(writeFile('/release/.attack','attack'));await assert.rejects(new Promise((resolve,reject)=>{const s=connect({host:"+JSON.stringify(${JSON.stringify(input.host)})+",port:${input.port}});s.setTimeout(1000,()=>{s.destroy();reject(Error('timeout'))});s.once('connect',()=>{s.destroy();resolve()});s.once('error',reject)}));await writeFile('/data/attack-receipt','denied-nonroot-offline');process.exit(73);";
  await writeFile('/data/attack.mjs',attack);const pkg=JSON.parse(await readFile('/data/source/package.json','utf8'));pkg.scripts={...pkg.scripts,postinstall:'node /data/attack.mjs'};await writeFile('/data/source/package.json',JSON.stringify(pkg));
 }
 const code=await run('/runtime/node',['/offline/npm/bin/npm-cli.js','ci','--offline','--include=dev','--no-audit','--no-fund','--cache=/data/cache','--userconfig=/dev/null','--globalconfig=/data/absent-global-npmrc'],'/data/source');
 if(${input.malicious}){assert.notEqual(code,0);assert.equal(await readFile('/data/attack-receipt','utf8'),'denied-nonroot-offline');process.stdout.write('malicious-postinstall-denied');}
 else{assert.equal(code,0);await stat('/data/source/bin/circle-hub');await writeFile('/data/source/release.json',JSON.stringify({schema:'circle-hub-release@1',id:${JSON.stringify(input.commit.slice(0,12))},commit:${JSON.stringify(input.commit)},created_at:new Date().toISOString()}));process.stdout.write('offline-npm-ci-ok');}`;
}

/** This exercise creates only synthetic bytes and returns no reusable real-data authorization or "safe" token. */
export async function proveSyntheticIsolation(mode:'normal'|'malicious-postinstall'='normal'):Promise<{root:string;build:string;user:string;namespace:string}> {
  await rootVmGate();
  const baseline=trustedRootMount(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')));
  // Offline bundle pin is supplied before the fixture runs. No network acquisition or owner configuration is read.
  const bundle=await verifyOfflineBundle(process.env.CIRCLE_HUB_TEST_OFFLINE_BUNDLE??'',process.env.CIRCLE_HUB_TEST_OFFLINE_SHA256??'');
  const id=randomBytes(6).toString('hex'), user=`chvm-${id}`, namespace=user;
  const build='/var/tmp/chvm-build-'+id,source=join(build,'release'),root='/var/tmp/'+user,node=await realpath(process.execPath);
  await assertCanonicalPath('/var/tmp');await assertFrozenParents(node);
  assert.equal(await hashFile(node),bundle.manifest.node_sha256,'Node 与离线包固定摘要不一致');
  let rootIdentity:Stats|undefined,buildIdentity:Stats|undefined;
  let rootCreated=false,buildCreated=false,accountCreated=false,namespaceCreated=false,externalCreated=false;
  const external='/var/tmp/chvm-host-'+id;
  let externalIdentity:Stats|undefined;
  const definition:IsolationDefinition={unit:`${user}-probe`,user,namespace,root,data:join(root,'data'),release:source,node};
  const env={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'};
  let userReceipt:{uid:number;gid:number;passwd:string;group:string}|undefined, namespaceIdentity:Stats|undefined, step='前置检查';
  const errors:Error[]=[];
  const run=async(command:string,args:string[])=>{const result=await runCommand(command,args,{env,timeoutMs:150_000});if(result.code!==0)throw new Error(`隔离步骤失败：${step}`);return result.stdout;};
  // The sentinel listens outside the future namespace. No production address is probed.
  const sentinel=createServer(socket=>socket.end('synthetic-only'));
  try {
    step='登记封闭构建根';
    sourceMountReceipt(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')),build,build,baseline);
    await mkdir(build,{mode:0o700});buildCreated=true;buildIdentity=await lstat(build);
    await mkdir(source,{mode:0o755});
    await mkdir(root,{mode:0o755});rootCreated=true;rootIdentity=await lstat(root);
    step='创建专用账户';
    await run('/usr/sbin/useradd',['--system','--user-group','--no-create-home','--home-dir','/data/home','--shell','/usr/sbin/nologin',user]);accountCreated=true;
    const uid=Number((await run('/usr/bin/id',['-u',user])).trim()),gid=Number((await run('/usr/bin/id',['-g',user])).trim());
    assert.ok(Number.isInteger(uid)&&uid>0&&Number.isInteger(gid)&&gid>0);
    userReceipt={uid,gid,passwd:await accountLine('/etc/passwd',user),group:await accountLine('/etc/group',user)};
    for(const dir of ['data/home','runtime','release','usr/lib','lib','lib64','etc','proc','dev','tmp','run','sentinel','offline','bin','usr/bin'])await mkdir(join(root,dir),{recursive:true,mode:0o755});
    await run('/usr/bin/chown',['-R',`${uid}:${gid}`,definition.data]);await chmod(definition.data,0o700);
    await writeFile(join(root,'etc/passwd'),`${user}:x:${uid}:${gid}:Synthetic:/data/home:/runtime/node\n`,{mode:0o644});
    await writeFile(join(root,'etc/group'),`${user}:x:${gid}:\n`,{mode:0o644});
    await writeFile(join(root,'etc/nsswitch.conf'),'passwd: files\ngroup: files\nhosts: files\n',{mode:0o644});
    await writeFile(join(root,'etc/hosts'),'127.0.0.1 localhost\n',{mode:0o644});
    // Mount destination must exist; this contains no executable until systemd binds the actual Node binary.
    await writeFile(join(root,'runtime/node'),'');
    step='创建无出口 namespace';
    await run('/usr/sbin/ip',['netns','add',namespace]);namespaceCreated=true;namespaceIdentity=await stat('/run/netns/'+namespace);
    await run('/usr/sbin/ip',['-n',namespace,'link','set','lo','up']);
    const interfaces=JSON.parse(await run('/usr/sbin/ip',['-n',namespace,'-j','link','show']));
    assert.deepEqual(interfaces.map((item:{ifname:string})=>item.ifname),['lo']);
    for(const family of ['-4','-6'])assert.deepEqual(JSON.parse(await run('/usr/sbin/ip',['-n',namespace,family,'-j','route','show','table','all'])).filter((route:{dev:string})=>route.dev!=='lo'),[]);
    const hostMounts=parseMountInfo(await readFile('/proc/self/mountinfo','utf8'));
    const bound=[{source:root,target:'/'},{source:definition.data,target:'/data'},{source:source,target:'/release'},{source:definition.node,target:'/runtime/node'}];
    for(const path of ['/usr/lib','/lib','/lib64']){try{bound.push({source:await realpath(path),target:path});}catch(error){if(path!=='/lib64'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    // Bind only the visible synthetic file; its unbound sibling stays outside the rootfs. Test parent /proc/root too.
    await mkdir(external,{mode:0o755});externalCreated=true;externalIdentity=await lstat(external);
    const sentinelPath=join(external,'hidden');await writeFile(sentinelPath,'synthetic-hidden',{mode:0o644,flag:'wx'});
    await writeFile(join(external,'visible'),'synthetic-visible',{mode:0o644,flag:'wx'});
    await writeFile(join(root,'sentinel/visible'),'');
    bound.push({source:join(external,'visible'),target:'/sentinel/visible'});
    const expected=[];
    for(const item of bound){await assertCanonicalPath(item.source);expected.push(sourceMountReceipt(hostMounts,item.source,item.target,baseline));}
    await new Promise<void>((resolve,reject)=>{sentinel.once('error',reject);sentinel.listen(0,'0.0.0.0',()=>resolve());});
    const address=sentinel.address();assert.ok(address&&typeof address!=='string');
    const network=JSON.parse(await run('/usr/sbin/ip',['-j','-4','address','show']));
    const outside=network.flatMap((row:{addr_info?:{local:string;scope:string}[]})=>row.addr_info??[]).find((item:{local:string;scope:string})=>item.scope==='global');
    assert.ok(outside,'VM 必须有外层合成哨兵可达的接口');
    const nodeScript=`
      import assert from 'node:assert/strict';import {connect} from 'node:net';import {readlink,readFile,access,writeFile,stat} from 'node:fs/promises';import {spawn} from 'node:child_process';
      const parse=${parseMountInfo.toString()};const verify=${verifyMountTable.toString()};
      const test=async()=>{
        verify(parse(await readFile('/proc/self/mountinfo','utf8')),${JSON.stringify(expected)});
        assert.equal(await readFile('/sentinel/visible','utf8'),'synthetic-visible');
        assert.equal(await readFile('/proc/self/root/sentinel/visible','utf8'),'synthetic-visible');
        await assert.rejects(access('/sentinel/hidden'));
        await assert.rejects(access('/proc/self/root/sentinel/hidden'));
        await assert.rejects(access('/proc/${process.pid}/root'+${JSON.stringify(sentinelPath)}));
        assert.notEqual(await readlink('/proc/self/ns/net'),${JSON.stringify(await import('node:fs/promises').then(m=>m.readlink('/proc/self/ns/net')))});
        assert.equal((await stat('/proc/self/ns/net')).ino,${(await stat('/run/netns/'+namespace)).ino});
        assert.equal((await stat('/')).ino,${(await stat(root)).ino});
        await writeFile('/data/probe-result','synthetic-only');
        for(const path of ${JSON.stringify([sentinelPath,'/mnt','/media','/Users','/Volumes','/host','/run/user'])})await assert.rejects(access(path));
        await assert.rejects(writeFile('/release/.synthetic-forbidden','synthetic'));
        await assert.rejects(new Promise((resolve,reject)=>{const s=connect({host:${JSON.stringify(outside.local)},port:${address.port}});s.setTimeout(1000,()=>{s.destroy();reject(new Error('timeout'));});s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);}));
        const ns=await readlink('/proc/self/ns/net');
        const child=spawn('/runtime/node',['--input-type=module','-e',"import {readlink} from 'node:fs/promises';process.exitCode=(await readlink('/proc/self/ns/net'))==="+JSON.stringify(ns)+"?0:7"],{stdio:'ignore'});
        assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),0);
      };await test();assert.match(process.env.INVOCATION_ID??'',/^[a-f0-9]{32}$/);await writeFile('/data/unit-receipt',JSON.stringify({invocation:process.env.INVOCATION_ID,uid:process.getuid(),net:(await stat('/proc/self/ns/net')).ino,root:(await stat('/')).ino}),{flag:'wx'});process.stdout.write('synthetic-isolation-probe-ok\\n');`;
    step='外层哨兵正例';
    // The positive control must succeed with the same destination before a negative result has meaning.
    const positive=await runCommand(definition.node,['--input-type=module','-e',`import {connect} from 'node:net';const s=connect({host:${JSON.stringify(outside.local)},port:${address.port}});s.setTimeout(2000,()=>{s.destroy();process.exitCode=2});s.on('data',()=>s.end());s.on('error',()=>process.exitCode=3);`],{env,timeoutMs:5000});assert.equal(positive.code,0);
    step='真实 systemd 根与网络进程隔离负例';
    assert.equal((await run('/usr/bin/systemd-run',isolatedUnitArguments(definition,['/runtime/node','--input-type=module','-e',nodeScript]))).trim(),'synthetic-isolation-probe-ok');
    assert.equal(await readFile(join(definition.data,'probe-result'),'utf8'),'synthetic-only');
    const receipt=JSON.parse(await readFile(join(definition.data,'unit-receipt'),'utf8'));assert.match(receipt.invocation,/^[a-f0-9]{32}$/);assert.equal(receipt.uid,userReceipt.uid);assert.equal(receipt.net,namespaceIdentity.ino);assert.equal(receipt.root,rootIdentity.ino);
    step='封闭离线非 root npm ci';
    const tools=[{source:bundle.path,target:'/offline'},{source:await realpath('/usr/bin/tar'),target:'/runtime/tar'},{source:await realpath('/bin/sh'),target:'/bin/sh'},{source:await realpath('/usr/bin/env'),target:'/usr/bin/env'}];
    for(const item of tools){await assertCanonicalPath(item.source);await assertFrozenParents(item.source);if(item.target!=='/offline')await writeFile(join(root,item.target),'');}
    await symlink('/offline/npm/bin/npm-cli.js',join(root,'runtime/npm'));
    const mountSnapshot=parseMountInfo(await readFile('/proc/self/mountinfo','utf8'));
    const buildExpected=[...expected,...tools.map(item=>sourceMountReceipt(mountSnapshot,item.source,item.target,baseline))];
    const program=offlineBuildProgram({uid,net:namespaceIdentity.ino,root:rootIdentity.ino,mounts:buildExpected,commit:bundle.manifest.source_commit,host:outside.local,port:address.port,malicious:mode==='malicious-postinstall'});
    const args=isolatedUnitArguments({...definition,unit:user+'-build'},['/runtime/node','--input-type=module','-e',program]).map(arg=>arg.startsWith('BindReadOnlyPaths=')?arg+' '+tools.map(item=>item.source+':'+item.target).join(' '):arg==='RuntimeMaxSec=120s'?'RuntimeMaxSec=600s':arg);
    const built=await runCommand('/usr/bin/systemd-run',args,{env,timeoutMs:660_000});
    assert.equal(built.code,0,'封闭离线 npm 构建未完成');
    assert.equal(built.stdout.trim(),mode==='malicious-postinstall'?'malicious-postinstall-denied':'offline-npm-ci-ok');
    assert.equal((await run('/usr/sbin/ip',['netns','pids',namespace])).trim(),'','构建 unit 尚有子进程，禁止冻结或清理');
    if(mode==='normal'){
      await rmdir(source);await rename(join(definition.data,'source'),source);await freezeBuiltTree(source);await assertRootOwnedTree(source);
      sourceMountReceipt(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')),source,'/release',baseline);
    }

  }catch{errors.push(new Error(`合成隔离证明失败：${step}；禁止实物演练`));}
  finally {
    await new Promise<void>(resolve=>sentinel.close(()=>resolve()));
    // Never stop a unit by a guessed name. --wait/--collect means success has already exited; on failure,
    // RuntimeMaxSec bounds the transient unit and any remaining PIDs keep namespace/account/root intact.
    let namespaceRemoved=false;
    if(namespaceIdentity)try{await assertCanonicalPath('/run/netns/'+namespace);assertSameIdentity(await stat('/run/netns/'+namespace),namespaceIdentity);assert.equal((await run('/usr/sbin/ip',['netns','pids',namespace])).trim(),'');await run('/usr/sbin/ip',['netns','delete',namespace]);namespaceRemoved=true;}catch{errors.push(new Error('本次 namespace 身份或清空状态未确认，不删除'));}
    let cleanupFailed=(namespaceCreated&&!namespaceRemoved)||(accountCreated&&!userReceipt)||(rootCreated&&!rootIdentity)||(buildCreated&&!buildIdentity)||(externalCreated&&!externalIdentity);
    if(cleanupFailed)errors.push(new Error('本次资源缺少创建身份或仍有进程，不按名字清理'));
    if(!cleanupFailed&&userReceipt)try{
      assert.equal(Number((await run('/usr/bin/id',['-u',user])).trim()),userReceipt.uid);
      assert.equal(Number((await run('/usr/bin/id',['-g',user])).trim()),userReceipt.gid);
      assert.equal(await accountLine('/etc/passwd',user),userReceipt.passwd);assert.equal(await accountLine('/etc/group',user),userReceipt.group);
      await run('/usr/sbin/userdel',[user]);
    }catch{cleanupFailed=true;errors.push(new Error('本次专用账户身份未确认，不删除'));}
    if(!cleanupFailed)try{
      if(rootIdentity){await assertCanonicalPath(root);assertSameIdentity(await lstat(root),rootIdentity);await rm(root,{recursive:true});}
      if(externalIdentity){await assertCanonicalPath(external);assertSameIdentity(await lstat(external),externalIdentity);await rm(external,{recursive:true});}
      if(buildIdentity){await assertCanonicalPath(build);assertSameIdentity(await lstat(build),buildIdentity);await rm(build,{recursive:true});}
    }catch{errors.push(new Error('本次目录身份未确认，不删除'));}
    if(errors.length)throw new AggregateError(errors,'隔离实证未通过；清理未确认的本次资源保持隔离，不得运行实物');
  }
  return {root,build,user,namespace};
}
