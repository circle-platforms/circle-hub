import '../packages/contracts/src/hub-environment.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import {SUPERVISOR_STOP_TIMEOUT_MS} from '../apps/server/src/shutdown.ts';
import {createSyntheticSources} from '../packs/synthetic/readonly-sources.ts';
import {setTimeout as delay} from 'node:timers/promises';

const root = fileURLToPath(new URL('../',import.meta.url));
const scratch = await mkdtemp(`${tmpdir()}/circle-hub-dev-`);
const socket = createServer(); await new Promise<void>(resolve => socket.listen(0,'127.0.0.1',resolve));
const port = (socket.address() as { port:number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
const dbPassword = randomBytes(24).toString('hex'); const userPassword = randomBytes(18).toString('base64url'); const workerPassword = randomBytes(18).toString('base64url');
const approverPassword=randomBytes(18).toString('base64url'),servicePassword=randomBytes(18).toString('base64url');
const syntheticTargets=['RESOURCE-LAB-01','record-feed-a','record-feed-b','document-store'];
const config = { host:'127.0.0.1',port,user:'circle_synthetic',password:dbPassword,database:'postgres' };
const children = new Set<ChildProcess>(); let closing = false;
const workerProcesses=new Map<string,ChildProcess>(),workerEnvironments=new Map<string,NodeJS.ProcessEnv>(),rollingWorkers=new WeakSet<ChildProcess>();let serverGeneration=0,workerRestart:Promise<void>|undefined;
function workerRecord(type:string,facts:Record<string,unknown>){console.log(JSON.stringify({type,at:new Date().toISOString(),...facts}));}
async function replaceWorkers(previousGeneration:number){
  while(!closing&&serverGeneration<=previousGeneration)await delay(50);if(closing)return;
  // Keep the peer serving child tools while one worker drains its existing jobs.
  // No timeout kills a running device operation merely to finish an upgrade.
  for(const [username,env] of workerEnvironments){if(closing)return;const child=workerProcesses.get(username);if(!child||child.exitCode!==null||child.signalCode!==null)continue;
    rollingWorkers.add(child);const exited=once(child,'exit');workerRecord('dev-stack.worker.draining',{username,processId:child.pid});child.send({type:'worker-drain'});await exited;if(closing)return;await launch('apps/worker/src/main.ts',env,'worker-ready');
  }
}
let syntheticSources:Awaited<ReturnType<typeof createSyntheticSources>>|undefined;
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child,'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); },SUPERVISOR_STOP_TIMEOUT_MS);
  try { await exited; } finally { clearTimeout(timeout); }
}
async function cleanup(): Promise<void> {
  if (closing) return; closing = true;
  // Reverse startup order: worker finishes its current local compilation, then server drains HTTP.
  for (const child of Array.from(children).reverse()) await stop(child);
  await syntheticSources?.close();
  await rm(scratch,{ recursive:true,force:true });
}
// npm and the terminal can deliver the same signal twice. Keep handlers installed
// until cleanup finishes; removing a once handler would let the second signal abort it.
process.on('SIGINT',() => { void cleanup(); }); process.on('SIGTERM',() => { void cleanup(); }); process.on('SIGHUP',() => { void cleanup(); });
async function launch(path: string,env: NodeJS.ProcessEnv,type: string): Promise<any> {
  // Separate groups keep terminal Ctrl+C under this supervisor's ordered shutdown.
  // IPC disconnect also lets children stop if this supervisor is killed.
  const child = spawn(process.execPath,[path],{ cwd:root,env,detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe','ipc'] }); children.add(child);
  const worker=path==='apps/worker/src/main.ts',username=env.CIRCLE_WORKER_USERNAME!;if(worker){workerProcesses.set(username,child);workerEnvironments.set(username,env);}
  child.on('message',message=>{if((message as any)?.type==='workers-restart'&&!closing&&!workerRestart){workerRestart=replaceWorkers(serverGeneration).catch(()=>{workerRecord('dev-stack.worker.restart-error',{reason:'replacement-failed'});}).finally(()=>{workerRestart=undefined;});}});
  child.stderr!.on('data',data => { process.stderr.write(data); });
  child.once('exit',(code,signal) => {children.delete(child);if(worker){if(workerProcesses.get(username)===child)workerProcesses.delete(username);workerRecord('dev-stack.worker.exit',{username,processId:child.pid,code,signal,graceful:rollingWorkers.has(child)&&code===0});if(!closing&&!rollingWorkers.has(child))void launch(path,env,type).catch(()=>workerRecord('dev-stack.worker.restart-error',{username,reason:'replacement-failed'}));return;}if (!closing) { console.error(JSON.stringify({ type:'dev-stack-child-exited',entryPoint:path,code,signal })); process.exitCode = 1; void cleanup(); } });
  return new Promise((resolve,reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Startup timed out for ${path}`)),20_000);
    child.once('error',error => { clearTimeout(timeout); reject(error); });
    child.once('exit',() => { clearTimeout(timeout); reject(new Error(`Startup failed for ${path}`)); });
    child.stdout!.on('data',data => {
      output += data.toString();
      const lines = output.split('\n'); output = lines.pop()!;
      for (const line of lines) {
        try { const value = JSON.parse(line);if(typeof value.type==='string'&&value.type.startsWith('supervisor.'))process.stdout.write(line+'\n');if(path==='apps/server/src/supervisor.ts'&&value.type==='ready')serverGeneration++; if (value.type === type) { clearTimeout(timeout);if(worker)workerRecord('dev-stack.worker.ready',{username,processId:child.pid}); resolve(value); } } catch { /* incomplete or human-readable output */ }
      }
    });
  });
}
try {
  const database = await launch('scripts/postgres-process.ts',{ ...process.env,CIRCLE_HUB_DATABASE_CONFIG:JSON.stringify(config),CIRCLE_HUB_PG_DIR:`${scratch}/pg` },'postgres-ready');
  if (closing) throw new Error('Stack startup was stopped');
  await mkdir(`${scratch}/objects`);
  syntheticSources=await createSyntheticSources();syntheticSources.state.expandedCommands=true;
  syntheticSources.state.manualText='# Synthetic manual\n**service create port**\nSet a synthetic port.\n**service create name**\nSet a synthetic label.';
  await writeFile(`${scratch}/connector-profiles.json`,JSON.stringify({profiles:{synthetic:{origin:syntheticSources.origin,root:'/dav/',index:'/builds/'}}}),{mode:0o600});
  await writeFile(`${scratch}/identities.json`,JSON.stringify({ identities:[
    { username:'developer',password:userPassword,principalId:'prn_developer',tenantId:'tnt_synthetic',kind:'user',
      scopes:['scp_lab'],grants:['tasks.read','tasks.submit','tasks.input','tasks.cancel','sources.read','sources.write','evidence.read','methods.use','operations.reconcile','admin.manage','admin.restart','rules.manage','decisions.approve','product.version','product.config.read','product.config.write','defects.search','defects.comment','docs.fetch','docs.convert','assets.read','assets.register','assets.change','assets.check','credentials.register','credentials.use','service-clients.manage','builds.read','environment.read','knowledge.read','knowledge.submit','knowledge.ingest','knowledge.publish','skillpacks.read','skillpacks.submit','skillpacks.run','automations.manage','automations.read','connectors.events'],targets:syntheticTargets,defects:['LAB-42'] },
    {username:'approver',password:approverPassword,principalId:'prn_approver',tenantId:'tnt_synthetic',kind:'user',scopes:['scp_lab'],grants:['tasks.read','decisions.approve','assets.read','assets.approve','knowledge.read','knowledge.review','skillpacks.read'],targets:[],defects:[]},
    {username:'defect-bot',password:servicePassword,principalId:'prn_defectbot',tenantId:'tnt_synthetic',kind:'service',scopes:['scp_lab'],grants:['tasks.read','tasks.submit','tasks.input','sources.read','sources.write','evidence.read','methods.use','product.version','defects.search','defects.comment','docs.fetch','docs.convert'],targets:syntheticTargets,defects:['LAB-42','SECRET-99']},
    { username:'lab-east-01',password:workerPassword,principalId:'prn_lab_east_01',tenantId:'tnt_synthetic',kind:'worker',workerId:'lab-east-01',
      scopes:['scp_lab'],grants:['workers.execute'],targets:syntheticTargets,defects:['LAB-42','SECRET-99'] },
    {username:'lab-east-02',password:workerPassword,principalId:'prn_lab_east_02',tenantId:'tnt_synthetic',kind:'worker',workerId:'lab-east-02',scopes:['scp_lab'],grants:['workers.execute'],targets:syntheticTargets,defects:['LAB-42','SECRET-99']},
  ] }),{ mode:0o600 });
  const samplePath = `${scratch}/synthetic-mindmap.xmind`;
  const content = [{ id:'sheet-circle-hub',rootTopic:{ id:'root',title:'Circle Hub 脑图编译验收',children:{ attached:[
    { title:'认证与任务',children:{ attached:[{ title:'登录后提交用例',notes:{ plain:{ content:'合成场景；检查身份和 scope' } } },{ title:'重连补读事件' }] } },
    { title:'制品',children:{ attached:[{ title:'下载并核对工作簿',notes:{ plain:{ content:'两表七列；核对源文件 SHA-256' } } }] } },
  ] } } }];
  await writeFile(samplePath,zipSync({ 'content.json':strToU8(JSON.stringify(content)),
    'metadata.json':strToU8(JSON.stringify({ creator:'circle-hub synthetic fixture' })) },{ mtime:new Date('2000-01-01T00:00:00Z') }),{ mode:0o600 });
  // Node loads NODE_EXTRA_CA_CERTS at process startup: bootstrap requests use
  // this process's trust, and the same runtime trust reaches server and workers.
  const env = { ...process.env,CIRCLE_HUB_MANAGED_WORKERS:'1',NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,CIRCLE_HUB_DATABASE_CONFIG:JSON.stringify(config),CIRCLE_HUB_DATA_DIR:`${scratch}/objects`,
    CIRCLE_HUB_DEV_IDENTITIES:`${scratch}/identities.json`,CIRCLE_HUB_DEV_AUTH:'1',CIRCLE_HUB_PORT:process.env.CIRCLE_HUB_PORT ?? '0',CIRCLE_SYNTHETIC_RESOURCE_DIR:`${scratch}/resources`,CIRCLE_HUB_CONNECTOR_PROFILES:`${scratch}/connector-profiles.json` };
  const server = await launch('apps/server/src/supervisor.ts',env,'ready');
  const login=async(username:string,password:string)=>{const response=await fetch(`${server.url}/v1/auth/dev-login`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});if(!response.ok)throw new Error('Synthetic asset login failed');return (await response.json() as any).data.token;};
  const developerToken=await login('developer',userPassword),approverToken=await login('approver',approverPassword);
  const post=async(path:string,value:unknown,token=developerToken)=>{const response=await fetch(`${server.url}${path}`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value)});const body=await response.json() as any;if(!response.ok)throw new Error(`Synthetic asset setup failed: ${body.error?.code}`);return body.data;};
  const observed=await fetch(`${server.url}/v1/runtime-profiles`,{redirect:'error',headers:{authorization:`Bearer ${developerToken}`}});if(!observed.ok)throw new Error('Synthetic runtime observation failed');
  for(const profile of (await observed.json() as any).data){const asset=await post('/v1/assets',{scopeId:'scp_lab',kind:'runtime-profile',name:'Synthetic development runtime',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{profileType:profile.profileType,profileRef:profile.profileRef,profileSha256:profile.profileSha256},readers:['*']});await post(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},approverToken);}
  for(const packageId of ['documents','build-site','query-mirror','environment-view','knowledge']){
    const definition={scopeId:'scp_lab',kind:'connector-instance',name:`Synthetic ${packageId}`,version:'1.0.0',declaration:{reads:['registered-source'],writes:packageId==='knowledge'?['knowledge-candidates']:[],credentials:[] as string[]},configuration:{packageId,runtimeProfileRef:'synthetic'},readers:['prn_developer','prn_approver']};
    let asset=await post('/v1/assets',definition);
    if(packageId==='query-mirror'){const credential=await post(`/v1/assets/${asset.assetId}/credentials`,{version:'1.0.0',value:syntheticSources.secret});asset=await post('/v1/assets',{...definition,assetId:asset.assetId,version:'2.0.0',declaration:{...definition.declaration,credentials:[credential.assetId]}});}
    await post(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},approverToken);
    await post(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});
  }
  await launch('apps/worker/src/main.ts',{ ...env,CIRCLE_HUB_URL:server.url,CIRCLE_WORKER_USERNAME:'lab-east-01',CIRCLE_WORKER_PASSWORD:workerPassword },'worker-ready');
  await launch('apps/worker/src/main.ts',{ ...env,CIRCLE_HUB_URL:server.url,CIRCLE_WORKER_USERNAME:'lab-east-02',CIRCLE_WORKER_PASSWORD:workerPassword },'worker-ready');
  console.log(JSON.stringify({ type:'dev-stack-ready',pid:process.pid,url:server.url,apiVersion:server.apiVersion,
    login:{ username:'developer',password:userPassword },approverLogin:{username:'approver',password:approverPassword},scopeId:'scp_lab',samplePath,scratchDirectory:scratch,postgresVersion:database.version,syntheticOnly:true }));
  console.log(`地址：${server.url}\n开发登录：POST /v1/auth/dev-login，用户名 developer，密码 ${userPassword}\n项目：scp_lab\n合成 XMind：${samplePath}\nCtrl+C 停止进程并删除本次临时数据库与制品`);
  console.log(`独立审批登录：approver，密码 ${approverPassword}`);
} catch (error) {
  console.error(JSON.stringify({ type:'dev-stack-startup-failed',message:error instanceof Error ? error.message : 'Unknown startup failure' }));
  process.exitCode = 1; await cleanup();
}
