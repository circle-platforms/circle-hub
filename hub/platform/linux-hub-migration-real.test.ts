// Opt-in destructive synthetic rehearsal, restricted to an administrator-declared disposable Linux VM.
// This starts the real archived Hub and real npm/systemd/PostgreSQL; no substituted model or HTTP endpoint exists.
import assert from 'node:assert/strict';
import {randomBytes, randomInt} from 'node:crypto';
import {lstat, readdir, realpath, statfs, writeFile} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {RECORD_KINDS} from '../../contracts/generated/protocol.ts';
import {createBackup, verifyBackup} from './backup.ts';
import {fileKeyStore} from './file-key.ts';
import {OPERATOR_TOKEN_ITEM} from './keychain.ts';
import {serviceDefinition, serviceEnvironment} from './launchd.ts';
import {ensureLayout, layoutAt} from './layout.ts';
import {createPostgres, ensureDatabaseRunning} from './postgres.ts';
import {runCommand} from './process.ts';
import {prepareRelease, switchCurrent} from './release.ts';
import {restoreBackup} from './restore.ts';
import {newSettingsFile, resolveSettings, writeSettingsFile} from './settings.ts';
import {systemdAgent, defaultSystemdDirectory} from './systemd.ts';
import {freePort} from './test-support.ts';
import {createVmRoots, pipeSyntheticKey, requireSyntheticVm} from './testing/linux-real-vm.ts';

const selected = process.env.CIRCLE_HUB_TEST_REAL_VM !== undefined;
const tree = fileURLToPath(new URL('../../', import.meta.url));

test('real Hub migrates synthetic vault and database across private VM roots', {
  skip: !selected ? 'requires explicitly authorized disposable VM: CIRCLE_HUB_TEST_REAL_VM=synthetic-only' : false,
  timeout: 3_600_000,
}, async t => {
  // A misspelled opt-in or non-VM is a failure, never a skip.
  await requireSyntheticVm();
  const roots = await createVmRoots();
  const account = userInfo(), node = await realpath(process.execPath);
  const baseEnv = {HOME:account.homedir, USER:account.username, PATH:`${dirname(node)}:/usr/bin:/bin`, LANG:'C', LC_ALL:'C', TZ:'UTC',
    XDG_RUNTIME_DIR:`/run/user/${account.uid}`, DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${account.uid}/bus`,
    NPM_CONFIG_USERCONFIG:join(roots.parent,'npmrc-absent'), NPM_CONFIG_GLOBALCONFIG:'/dev/null', NPM_CONFIG_CACHE:join(roots.parent,'npm-cache')};
  let step = '前置检查';
  const failures: Error[] = [];
  let linkOwned = false, linkIndex:number|undefined;
  const link = `ch${randomBytes(5).toString('hex')}`, alias = `circle-hub-synthetic-${randomBytes(16).toString('hex')}`;
  let address = '';
  const layout = [layoutAt(roots.source), layoutAt(roots.target)];
  const units = [roots.unit+'-source', roots.unit+'-target'];
  const agents = units.map(label => systemdAgent({label, directory:defaultSystemdDirectory(account.homedir), uid:account.uid}));
  const clusters: ReturnType<typeof createPostgres>[] = [];
  const command = async (program:string, args:string[], env:NodeJS.ProcessEnv = baseEnv, input?:string) => {
    const result = await runCommand(program,args,{env, input, timeoutMs:120_000});
    if (result.code !== 0) throw new Error(`步骤失败：${step}（退出码 ${result.code}）`);
    return result.stdout;
  };
  const mark = (value:string) => {step=value; t.diagnostic(`步骤：${value}`);};
  try {
    const fs = await statfs(roots.parent);
    // Refuse common shared filesystems (9p, virtiofs and NFS); npm's native modules must live on VM-local storage.
    assert.ok(![0x01021997,0x65735546,0x6969].includes(Number(fs.type)), '测试目录必须在 VM 本地文件系统');
    assert.ok(Number(fs.bavail)*Number(fs.bsize) >= 8*1024**3, '测试需要至少 8 GiB 可用空间');
    await command('/usr/bin/systemctl',['--user','show-environment']);
    await command('bwrap',['--version']);
    await command('pg_dump',['--version']); await command('pg_restore',['--version']);
    // No existing unit is ever adopted: even inactive fragments must be absent.
    for (const agent of agents) assert.equal((await agent.status()).installed,false);
    const commit = (await command('git',['-C',tree,'rev-parse','HEAD'])).trim();
    assert.match(commit,/^[a-f0-9]{40}$/);
    // Inspect committed source only; these interfaces must be included in the actual release, not the test checkout.
    const cliSource = await command('git',['-C',tree,'show',`${commit}:hub/platform/cli.ts`]);
    assert.ok(cliSource.includes('exportVaultKey') && cliSource.includes('importVaultKey'), 'key-transfer 尚未合入');
    const settingsSource = await command('git',['-C',tree,'show',`${commit}:hub/platform/settings.ts`]);
    assert.ok(settingsSource.includes('listen_host') && settingsSource.includes('allowed_hosts'), 'hub-listen 尚未合入');
    const adminSource = await command('git',['-C',tree,'show',`${commit}:hub/server/cli-admin.ts`]);
    assert.ok(adminSource.includes('records.vault.verify'), '逐条密钥库核验尚未合入');

    mark('创建独占合成网络接口');
    const addresses = JSON.parse(await command('/usr/sbin/ip',['-j','address','show'])) as {addr_info?:{local:string}[]}[];
    const occupied = new Set(addresses.flatMap(row => row.addr_info?.map(a=>a.local)??[]));
    const candidates = Array.from({length:253},(_,i)=>`192.0.2.${i+1}`).filter(a=>!occupied.has(a));
    assert.ok(candidates.length > 0);
    address = candidates[randomInt(candidates.length)]!;
    await command('/usr/bin/sudo',['-n','/usr/sbin/ip','link','add','name',link,'type','dummy']);
    linkOwned = true;
    const created = JSON.parse(await command('/usr/sbin/ip',['-j','link','show','dev',link]));
    linkIndex = created[0].ifindex;
    await command('/usr/bin/sudo',['-n','/usr/sbin/ip','link','set','dev',link,'alias',alias]);
    await command('/usr/bin/sudo',['-n','/usr/sbin/ip','address','add',address+'/32','dev',link]);
    await command('/usr/bin/sudo',['-n','/usr/sbin/ip','link','set','dev',link,'up']);

    const ports = [await freePort(),await freePort()];
    assert.notEqual(ports[0],ports[1]);
    const settings = layout.map((root,i) => {
      const file = newSettingsFile({environment:'test',port:ports[i],keychainService:`synthetic-${randomBytes(8).toString('hex')}`});
      // Use the persisted public shape after the listen branch is present; no fake host/runner is injected.
      const endpoint = {...file, listen_host:i===0?'127.0.0.1':address, allowed_hosts:[i===0?'127.0.0.1':address]};
      return {file:endpoint, resolved:{...resolveSettings(endpoint,{},root),label:units[i]!}};
    });
    const releases = [];
    for (let i=0;i<2;i++) {
      mark(`真实 release npm ci：${i===0?'源':'目标'}`);
      await ensureLayout(layout[i]!);
      await writeSettingsFile(layout[i]!,settings[i]!.file);
      const release = await prepareRelease({path:tree,commit},{layout:layout[i]!,env:baseEnv});
      assert.equal(release.reused,false); assert.equal(release.file.commit,commit);
      assert.ok((await lstat(join(release.dir,'node_modules'))).isDirectory());
      assert.equal((await lstat(join(release.dir,'node_modules'))).isSymbolicLink(),false);
      const cluster = createPostgres({layout:layout[i]!,binariesRoot:release.dir});
      clusters.push(cluster); releases.push(release);
      const binaries = await cluster.binaries();
      for (const binary of Object.values(binaries)) {
        const linked = await command('/usr/bin/ldd',[binary]);
        assert.ok(!linked.includes('not found'),'嵌入式 PostgreSQL 动态链接依赖缺失');
      }
      assert.equal((await cluster.binaryVersion()).major,18);
      assert.match(await command('pg_dump',['--version']),/\b18\./);
      assert.match(await command('pg_restore',['--version']),/\b18\./);
      await switchCurrent(layout[i]!,release.id);
    }
    const envs = layout.map((root,i) => serviceEnvironment(root,settings[i]!.resolved,{home:account.homedir,user:account.username,database:settings[i]!.resolved.database}));
    const cli = (i:number,args:string[],input?:string) => command(node,[join(releases[i]!.dir,'bin','circle-hub'),...args],{...baseEnv,...envs[i]},input);
    mark('源真实数据库迁移和合成管理员');
    await clusters[0]!.initialise(); await ensureDatabaseRunning(clusters[0]!,{create:true});
    await cli(0,['serve','--migrate-only']);
    await cli(0,['key','init']); await cli(0,['init-admin','合成管理员']);
    mark('源正式密钥库写入与逐条核验');
    for (let i=0;i<3;i++) {
      const name = `SYNTHETIC_VM_SECRET_${i}`;
      // Register a synthetic credential consumer through the real CLI; never contact or dispatch it.
      const definitionPath=join(roots.parent,`executor-${i}.json`);
      const call=(tool:string)=>({tool,arguments:{}});
      const definition={schema:'executor@1',enabled:true,environment:'test',target:`synthetic-${i}`,endpoint:'http://127.0.0.1:1/mcp',ca:'',
        credential:'${secret:'+name+'}',max_run_ms:1000,payload_argument:'/blob',
        allowed_tools:['open','touch','close','inspect','submit','status','result'],
        calls:{acquire:call('open'),heartbeat:call('touch'),release:call('close'),precheck:call('inspect'),
          submit:{tool:'submit',arguments:{request:{$value:'request_id'},sequence:{$value:'dispatch_sequence'},scope:{$value:'sequence_scope'},blob:{$value:'payload_base64'}}},status:call('status'),result:call('result')},
        lease:{id:'/id',token:'/token',ttl_ms:'/ttl',acceptance:'/ok',map:{yes:'accepted'}},
        receipt:{acceptance:'/ok',map:{yes:'accepted'},id:'/id',sha256:'/sha',items:'/items'},
        status:{pointer:'/status',map:{}},result:{id:'/id',sha256:'/sha',submitted_at:'/at',items:'/items',item_id:'/id',item_outcome:'/outcome',complete:'/complete',map:{}},
        conditions:[],read_retry_when:[],proof:{package:'synthetic-workflow',manifest_sha256:'/manifest',requirement:'synthetic',slot:'synthetic',plan_run:'/run',sha256:'/sha',items:'/items',target:'/target',build:'/build',generator:'/generator'}};
      await writeFile(definitionPath,JSON.stringify(definition),{mode:0o600,flag:'wx'});
      await cli(0,['executor','add',definitionPath]);
      await cli(0,['secret','set','--name',name,'--reason','合成迁移验证'],randomBytes(48+i*24).toString('hex')+'\n');
    }
    const vaultCheck = await cli(0,['records','verify','--vault']);
    assert.match(vaultCheck,/已核验 3 条；异常 0 项/);
    const files = await readdir(layout[0]!.vault); assert.equal(files.length,3);
    const tokenOf = async (i:number) => {
      const store = fileKeyStore({root:layout[i]!.root,service:settings[i]!.resolved.keychainService,account:'operator-token',item:OPERATOR_TOKEN_ITEM});
      const bytes = await store.read(); try{return Buffer.from(bytes).toString('base64url');}finally{bytes.fill(0);}
    };
    const rpc = async (i:number,token:string,method:string) => {
      const host = i===0?'127.0.0.1':address;
      const response = await fetch(`http://${host}:${ports[i]}/mcp`,{method:'POST',signal:AbortSignal.timeout(10_000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-vm-migration',version:'1'}}:{}})});
      assert.equal(response.status,200);
      const text=await response.text();
      const event=text.split('\n').find(line=>line.startsWith('data:'));
      const message=JSON.parse(event ? event.slice(5) : text);
      assert.equal(message.jsonrpc,'2.0'); assert.equal(message.id,1); assert.equal(message.error,undefined);
      return message.result;
    };
    mark('源真实 systemd 与 MCP initialize');
    await agents[0]!.install(serviceDefinition(layout[0]!,settings[0]!.resolved,{node,home:account.homedir,user:account.username,database:settings[0]!.resolved.database}));
    const wait = async (i:number) => {
      const host=i===0?'127.0.0.1':address;
      for(let n=0;n<100;n++) {
        try {const response=await fetch(`http://${host}:${ports[i]}/healthz`,{signal:AbortSignal.timeout(500)});if(response.ok){const health=await response.json();if(health.status==='ok' && health.release===releases[i]!.id)return;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      throw new Error('真实 Hub 健康检查超时');
    };
    await wait(0);
    const sourceStatus=await agents[0]!.status();assert.ok(sourceStatus.running && sourceStatus.pid);
    assert.equal(await realpath(`/proc/${sourceStatus.pid}/cwd`),releases[0]!.dir);
    assert.equal((await rpc(0,await tokenOf(0),'initialize')).serverInfo.name,'circle-hub');
    mark('真实 backup@3 与源停写禁自启');
    const backup = await createBackup({layout:layout[0]!,postgres:clusters[0]!,libpqBin:'/usr/bin'});
    const manifest=await verifyBackup(backup.dir);
    assert.equal(manifest.schema,'circle-hub-backup@3');
    assert.equal(manifest.files.filter(f=>f.path.startsWith('vault/')).length,3);
    assert.ok(manifest.files.some(f=>f.path.startsWith('objects/')));
    assert.ok(manifest.database.tables.some(table=>table.rows>0));
    assert.ok(manifest.files.every(f=>f.path==='database.dump'||/^(objects|vault|config)\//.test(f.path)));
    await agents[0]!.uninstall(); await clusters[0]!.stop();
    assert.equal((await agents[0]!.status()).running,false);
    const disabled=await runCommand('/usr/bin/systemctl',['--user','is-enabled',units[0]!+'.service'],{env:baseEnv});
    assert.notEqual(disabled.code,0);
    await assert.rejects(fetch(`http://127.0.0.1:${ports[0]}/healthz`,{signal:AbortSignal.timeout(1000)}));
    mark('空数据根 restore 与主密钥纯管道');
    assert.deepEqual(await readdir(layout[1]!.db),[]); assert.deepEqual(await readdir(layout[1]!.vault),[]);
    await restoreBackup({layout:layout[1]!,backupDir:backup.dir,postgres:clusters[1]!,libpqBin:'/usr/bin'});
    const keyCommand=(i:number,args:string[])=>({node,args:[join(releases[i]!.dir,'bin','circle-hub'),...args],env:{...baseEnv,...envs[i]},cwd:releases[i]!.dir});
    await pipeSyntheticKey(keyCommand(0,['key','export','--confirm']),keyCommand(1,['key','import']));
    await assert.rejects(pipeSyntheticKey(keyCommand(0,['key','export','--confirm']),keyCommand(1,['key','import'])));
    // Backup excludes operator-token keys; reissue uses the restored enabled synthetic administrator.
    await cli(1,['operator-token','reissue','--as','合成管理员']);
    const keyDir=join(layout[1]!.root,'keys');
    assert.equal((await lstat(keyDir)).mode&0o777,0o700);
    for(const entry of await readdir(keyDir)){const info=await lstat(join(keyDir,entry));assert.equal(info.mode&0o777,0o600);assert.equal(info.uid,account.uid);assert.ok(info.isFile());}
    assert.notEqual(await tokenOf(0),await tokenOf(1));
    assert.match(await cli(1,['records','verify','--vault']),/已核验 3 条；异常 0 项/);
    for(const kind of RECORD_KINDS)await cli(1,['records','verify','--kind',kind]);
    mark('目标真实 systemd 非回环 MCP 与 Host/Origin 拒绝');
    await agents[1]!.install(serviceDefinition(layout[1]!,settings[1]!.resolved,{node,home:account.homedir,user:account.username,database:settings[1]!.resolved.database}));
    await wait(1);
    const targetStatus=await agents[1]!.status();assert.ok(targetStatus.running && targetStatus.pid);
    assert.equal(await realpath(`/proc/${targetStatus.pid}/cwd`),releases[1]!.dir);
    const token=await tokenOf(1), initialized=await rpc(1,token,'initialize');
    assert.equal(initialized.serverInfo.name,'circle-hub'); assert.equal(initialized.protocolVersion,'2025-06-18');
    const tools=await rpc(1,token,'tools/list'); assert.equal(tools.tools.length,6);
    for(const headers of [{Host:'not-authorized.invalid'},{Origin:'http://not-authorized.invalid'}] as Record<string,string>[]) {
      const response=await fetch(`http://${address}:${ports[1]}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:'{}',signal:AbortSignal.timeout(3000)});
      assert.equal(response.status,403);
    }
    assert.equal((await agents[0]!.status()).running,false);
    t.diagnostic('真实 Hub 合成跨根迁移验证完成；不代表真实数据或目标部署');
  } catch {failures.push(new Error(`真实 Hub 演练失败：${step}（子进程输出不披露）`));}
  finally {
    const failuresBeforeCleanup=failures.length;
    for(const agent of [...agents].reverse())try{await agent.uninstall();}catch{failures.push(new Error('独占测试单元清理失败'));}
    for(const cluster of [...clusters].reverse())try{await cluster.stop();}catch{failures.push(new Error('独占测试 PostgreSQL 清理失败'));}
    if(linkOwned)try{
      const current=JSON.parse(await command('/usr/sbin/ip',['-j','link','show','dev',link]));
      assert.equal(current[0].ifindex,linkIndex);
      // The alias may be absent if the first set operation failed; inode-like interface index remains required.
      assert.ok(current[0].ifalias===alias || current[0].ifalias===undefined);
      await command('/usr/bin/sudo',['-n','/usr/sbin/ip','link','delete','dev',link]);
    }catch{failures.push(new Error('独占测试接口清理失败'));}
    // Preserve roots on any failure for VM-only investigation; no recursive removal while a process may remain.
    if(failures.length===failuresBeforeCleanup)try{await roots.cleanup();}catch{failures.push(new Error('独占测试目录清理失败'));}
    if(failures.length)throw new AggregateError(failures,'真实 Hub 合成迁移未通过（清理失败时保留本次 VM 数据根）');
  }
});
