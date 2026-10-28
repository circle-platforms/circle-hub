// Root-only synthetic VM isolation fixture. No backup, keychain or production deployment is accepted as input.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {runCommand} from '../process.ts';

const safePath = (path:string) => path.startsWith('/') && /^\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').includes('..');
export interface IsolationDefinition {unit:string; user:string; namespace:string; root:string; data:string; release:string; node:string}

/** Only a generated synthetic identity and simple absolute paths may enter systemd's property parser. */
export function isolatedUnitArguments(d:IsolationDefinition, programArgs:string[]):string[] {
  if(!/^chvm-[a-f0-9]{12}$/.test(d.user) || !/^chvm-[a-f0-9]{12}$/.test(d.namespace) || !/^chvm-[a-f0-9]{12}-[a-z0-9-]+$/.test(d.unit))throw new Error('隔离身份不属于本次合成命名空间');
  if(![d.root,d.data,d.release,d.node].every(safePath))throw new Error('隔离路径不安全');
  if(d.data!==join(d.root,'data') || !programArgs.length || programArgs[0]!=='/runtime/node')throw new Error('隔离入口或数据根无效');
  const properties=[
    `User=${d.user}`,`Group=${d.user}`,`RootDirectory=${d.root}`,`NetworkNamespacePath=/run/netns/${d.namespace}`,
    'PrivateMounts=yes','PrivateDevices=yes','PrivateTmp=yes','ProtectSystem=strict','ProtectHome=yes',
    'ProtectProc=invisible','ProcSubset=pid','NoNewPrivileges=yes','CapabilityBoundingSet=',
    'AmbientCapabilities=','RestrictSUIDSGID=yes','RestrictNamespaces=yes','LockPersonality=yes',
    'ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectKernelLogs=yes','ProtectControlGroups=yes',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6','RemoveIPC=yes','UMask=0077','KillMode=control-group',
    'SendSIGKILL=yes','TimeoutStopSec=15s','RuntimeMaxSec=120s','Restart=no',
    `BindReadOnlyPaths=${d.node}:/runtime/node ${d.release}:/release /usr/lib /lib -/lib64`,
    `BindPaths=${d.data}:/data`,'ReadWritePaths=/data','WorkingDirectory=/data',
    'InaccessiblePaths=-/mnt -/media -/Users -/Volumes -/host -/run/user',
  ];
  return ['--quiet','--wait','--pipe','--collect',`--unit=${d.unit}`,...properties.flatMap(property=>['--property',property]),
    '--setenv=HOME=/data/home','--setenv=PATH=/runtime','--setenv=LANG=C','--setenv=CIRCLE_HUB_DATA_DIR=/data',
    '--',...programArgs];
}

async function rootVmGate():Promise<void> {
  if(process.platform!=='linux'||process.getuid?.()!==0||process.versions.node.split('.')[0]!=='24'||process.env.CIRCLE_HUB_TEST_ISOLATION_VM!=='synthetic-only')throw new Error('隔离夹具只允许显式授权 Linux VM 的 Node24 管理员');
  const marker=await open('/run/circle-hub-synthetic-vm',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=await marker.stat();assert.ok(info.isFile()&&info.uid===0&&info.nlink===1&&(info.mode&0o777)===0o644);assert.equal(await marker.readFile('utf8'),'circle-hub-synthetic-only-v1\n');}finally{await marker.close();}
  const detected=await runCommand('/usr/bin/systemd-detect-virt',['--vm','--quiet'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeoutMs:10_000});
  if(detected.code!==0)throw new Error('拒绝在未识别 VM 的主机创建隔离夹具');
}

/** This exercise creates only synthetic bytes and returns no reusable real-data authorization or "safe" token. */
export async function proveSyntheticIsolation(release:string):Promise<void> {
  await rootVmGate();
  if(!safePath(release))throw new Error('发布路径不安全');
  const source=await realpath(release);
  if(!source.startsWith('/var/tmp/chvm-build-'))throw new Error('只接受 VM 专用 chvm-build 暂存 release，拒绝现有部署路径');
  if(!(await lstat(join(source,'bin','circle-hub'))).isFile())throw new Error('必须使用预备的真实 Hub release');
  const id=randomBytes(6).toString('hex'), user=`chvm-${id}`, namespace=user;
  const root=await mkdtemp('/var/tmp/chvm-');await chmod(root,0o755);
  const definition:IsolationDefinition={unit:`${user}-probe`,user,namespace,root,data:join(root,'data'),release:source,node:await realpath(process.execPath)};
  const env={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'};
  let userCreated=false, namespaceCreated=false, unitStarted=false, step='前置检查';
  const errors:Error[]=[];
  const run=async(command:string,args:string[])=>{const result=await runCommand(command,args,{env,timeoutMs:150_000});if(result.code!==0)throw new Error(`隔离步骤失败：${step}`);return result.stdout;};
  // The sentinel listens outside the future namespace. No production address is probed.
  const sentinel=createServer(socket=>socket.end('synthetic-only'));
  try {
    step='创建专用账户';
    await run('/usr/sbin/useradd',['--system','--user-group','--no-create-home','--home-dir','/data/home','--shell','/usr/sbin/nologin',user]);userCreated=true;
    const uid=Number((await run('/usr/bin/id',['-u',user])).trim()),gid=Number((await run('/usr/bin/id',['-g',user])).trim());
    assert.ok(Number.isInteger(uid)&&uid>0&&Number.isInteger(gid)&&gid>0);
    for(const dir of ['data/home','runtime','release','usr/lib','lib','lib64','etc','proc','dev','tmp','run'])await mkdir(join(root,dir),{recursive:true,mode:0o755});
    await run('/usr/bin/chown',['-R',`${uid}:${gid}`,definition.data]);await chmod(definition.data,0o700);
    await writeFile(join(root,'etc/passwd'),`${user}:x:${uid}:${gid}:Synthetic:/data/home:/runtime/node\n`,{mode:0o644});
    await writeFile(join(root,'etc/group'),`${user}:x:${gid}:\n`,{mode:0o644});
    await writeFile(join(root,'etc/nsswitch.conf'),'passwd: files\ngroup: files\nhosts: files\n',{mode:0o644});
    await writeFile(join(root,'etc/hosts'),'127.0.0.1 localhost\n',{mode:0o644});
    // Mount destination must exist; this contains no executable until systemd binds the actual Node binary.
    await writeFile(join(root,'runtime/node'),'');
    step='创建无出口 namespace';
    await run('/usr/sbin/ip',['netns','add',namespace]);namespaceCreated=true;
    await run('/usr/sbin/ip',['-n',namespace,'link','set','lo','up']);
    const interfaces=JSON.parse(await run('/usr/sbin/ip',['-n',namespace,'-j','link','show']));
    assert.deepEqual(interfaces.map((item:{ifname:string})=>item.ifname),['lo']);
    for(const family of ['-4','-6'])assert.deepEqual(JSON.parse(await run('/usr/sbin/ip',['-n',namespace,family,'-j','route','show','table','all'])).filter((route:{dev:string})=>route.dev!=='lo'),[]);
    const hostNs=await readFile('/proc/self/mountinfo','utf8');assert.ok(hostNs.length>0);
    // Synthetic host-only files include a same-account file, denying a /proc/<pid>/root or host-mount escape.
    const sentinelPath=join(root,'host-only-synthetic');await writeFile(sentinelPath,'synthetic',{mode:0o644});
    await new Promise<void>((resolve,reject)=>{sentinel.once('error',reject);sentinel.listen(0,'0.0.0.0',()=>resolve());});
    const address=sentinel.address();assert.ok(address&&typeof address!=='string');
    const network=JSON.parse(await run('/usr/sbin/ip',['-j','-4','address','show']));
    const outside=network.flatMap((row:{addr_info?:{local:string;scope:string}[]})=>row.addr_info??[]).find((item:{local:string;scope:string})=>item.scope==='global');
    assert.ok(outside,'VM 必须有外层合成哨兵可达的接口');
    const nodeScript=`
      import assert from 'node:assert/strict';import {connect} from 'node:net';import {readlink,readFile,access,writeFile,stat} from 'node:fs/promises';import {spawn} from 'node:child_process';
      const test=async()=>{
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
      };await test();process.stdout.write('synthetic-isolation-probe-ok\\n');`;
    step='外层哨兵正例';
    // The positive control must succeed with the same destination before a negative result has meaning.
    const positive=await runCommand(definition.node,['--input-type=module','-e',`import {connect} from 'node:net';const s=connect({host:${JSON.stringify(outside.local)},port:${address.port}});s.setTimeout(2000,()=>{s.destroy();process.exitCode=2});s.on('data',()=>s.end());s.on('error',()=>process.exitCode=3);`],{env,timeoutMs:5000});assert.equal(positive.code,0);
    step='真实 systemd 根与网络进程隔离负例';unitStarted=true;
    assert.equal((await run('/usr/bin/systemd-run',isolatedUnitArguments(definition,['/runtime/node','--input-type=module','-e',nodeScript]))).trim(),'synthetic-isolation-probe-ok');
    assert.equal(await readFile(join(definition.data,'probe-result'),'utf8'),'synthetic-only');
  }catch{errors.push(new Error(`合成隔离证明失败：${step}；禁止实物演练`));}
  finally {
    await new Promise<void>(resolve=>sentinel.close(()=>resolve()));
    if(unitStarted)try{
      const state=await runCommand('/usr/bin/systemctl',['show',definition.unit,'--property=LoadState','--value'],{env,timeoutMs:5000});
      if(state.stdout.trim()!=='not-found')await run('/usr/bin/systemctl',['stop',definition.unit]);
    }catch{errors.push(new Error('本次隔离单元停止未确认'));}
    if(namespaceCreated)try{assert.equal((await run('/usr/sbin/ip',['netns','pids',namespace])).trim(),'');await run('/usr/sbin/ip',['netns','delete',namespace]);}catch{errors.push(new Error('本次 namespace 未能确认清空并删除'));}
    if(errors.length===0&&userCreated)try{await run('/usr/sbin/userdel',[user]);}catch{errors.push(new Error('本次专用账户清理失败'));}
    if(errors.length===0)await rm(root,{recursive:true});
    if(errors.length)throw new AggregateError(errors,'隔离实证未通过；本次资源保持隔离供管理员处理，不得运行实物');
  }
}
