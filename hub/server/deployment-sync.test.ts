import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncReport } from '../knowledge/api.ts';
import { unchangedDeploymentProbe } from './deployment-sync.ts';

function probe(): SyncReport {
  return { sync:'synthetic',product:'synthetic',pack:'synthetic@1.0.0',dry_run:true,started_at:'2026-11-13T00:00:00.000Z',ended_at:'2026-11-13T00:00:01.000Z',
    plan:{rounds:1,done:true,note:null,builds:1,reads:1,failed_reads:[],limits:{rounds:false,reads:false,max_rounds:6,max_reads:300}},
    builds:[{name:'synthetic-build',family:'synthetic',line:'synthetic-line',base:'synthetic-build',outcome:'skipped',reason:'synthetic',root:'a'.repeat(64),composition:'b'.repeat(64)}],
    pointers:[],counts:{produced:0,registered:0,skipped:1,failed:0},warnings:[],error:null };
}
test('only a complete fresh probe with every existing root unchanged skips actual synchronization', () => {
  assert.equal(unchangedDeploymentProbe(probe(),'synthetic-line'),true);
  const changed=probe();changed.builds[0].would_produce=true;assert.equal(unchangedDeploymentProbe(changed,'synthetic-line'),false);
  const missing=probe();missing.builds[0].root=null;assert.equal(unchangedDeploymentProbe(missing,'synthetic-line'),false);
  const scope=probe();scope.scope={outcome:'skipped',reason:'synthetic',root:null,composition:null,would_produce:true};assert.equal(unchangedDeploymentProbe(scope,'synthetic-line'),false);
});
test('unknown, partial, failed, or non-probe results never claim current', () => {
  const reports: SyncReport[]=[];
  let report=probe();report.dry_run=false;reports.push(report);
  report=probe();report.plan.done=false;reports.push(report);
  report=probe();report.plan.limits.reads=true;reports.push(report);
  report=probe();report.plan.failed_reads.push({id:'synthetic-source',reason:'unavailable'});reports.push(report);
  report=probe();report.counts.failed=1;reports.push(report);
  report=probe();report.error='synthetic failure';reports.push(report);
  report=probe();report.builds=[];reports.push(report);
  report=probe();report.builds[0].outcome='registered';reports.push(report);
  report=probe();report.builds[0].composition=null;reports.push(report);
  for (const result of reports) assert.equal(unchangedDeploymentProbe(result,'synthetic-line'),false);
});

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, type HubConfig } from '../config/index.ts';
import { deploymentSyncStatus } from './deployment-sync.ts';

async function statusFixture(t: { after(fn: () => Promise<void>): void }) {
  const root=await mkdtemp(join(tmpdir(),'circle-hub-sync-status-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'run','deployment-sync');await mkdir(directory,{recursive:true,mode:0o700});
  const id='550e8400-e29b-41d4-a716-446655440000';
  const config:HubConfig={dataDir:root,logDir:join(root,'logs'),host:'127.0.0.1',port:0,database:{host:'127.0.0.1',port:1,database:'unused',user:'unused'},limits:DEFAULT_LIMITS};
  const session={config:()=>config,admin:async()=>({id:'usr_'+ '0'.repeat(26),name:'synthetic',role:'admin' as const})};
  const request={id,actor:'usr_'+ '0'.repeat(26),product:'synthetic',line:null,databaseOid:'123',submittedAt:Date.now()};
  await writeFile(join(directory,id+'.request.json'),JSON.stringify(request),{mode:0o600});
  const status={id,product:'synthetic',line:null,running:false,completed:false,probing:false,synchronized:false,current:false};
  const statusPath=join(directory,id+'.status.json');
  await writeFile(statusPath,JSON.stringify(status),{mode:0o600});
  return {root,directory,id,config,session,request,status,statusPath};
}
test('status reads survive a new caller without a parent Session or business database',async t=>{
  const f=await statusFixture(t);
  assert.deepEqual(await deploymentSyncStatus(f.session,f.id),f.status);
  const denied={...f.session,admin:async()=>{throw new Error('synthetic denied');}};
  await assert.rejects(deploymentSyncStatus(denied,f.id),/synthetic denied/);
  await assert.rejects(deploymentSyncStatus(f.session,'../escape'));
});
test('status rejects nonprivate files and symlinks',async t=>{
  const f=await statusFixture(t);
  await chmod(f.statusPath,0o644);await assert.rejects(deploymentSyncStatus(f.session,f.id));
  await rm(f.statusPath);
  const outside=join(f.root,'outside.json');await writeFile(outside,JSON.stringify(f.status),{mode:0o600});
  await symlink(outside,f.statusPath);await assert.rejects(deploymentSyncStatus(f.session,f.id));
});
test('an incomplete submission or unconfirmed supervisor is terminal unknown rather than current',async t=>{
  const f=await statusFixture(t);
  await rm(f.statusPath);
  let status=await deploymentSyncStatus(f.session,f.id);
  assert.equal(status.completed,true);assert.equal(status.current,false);assert.ok(status.error);
  await writeFile(f.statusPath,JSON.stringify(f.status),{mode:0o600});
  await writeFile(join(f.directory,f.id+'.request.json'),JSON.stringify({...f.request,submittedAt:0}),{mode:0o600});
  status=await deploymentSyncStatus(f.session,f.id);
  assert.equal(status.completed,true);assert.equal(status.current,false);assert.ok(status.error);
});

import { readFile } from 'node:fs/promises';
import { CODE_ROOT, createContext, ensureLayout, layoutAt, newSettingsFile, writeSettingsFile, settingsOf, serviceEnvironment, identityOf, type CommandOptions } from '../platform/api.ts';
import { loadServerConfig } from './main.ts';
import { launchDeploymentSyncSupervisor } from './deployment-sync.ts';
async function supervisorFixture(t:{after(fn:()=>Promise<void>):void},platform:NodeJS.Platform) {
  const root=await mkdtemp(join(tmpdir(),'circle-hub-sync-supervisor-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const layout=layoutAt(root);await ensureLayout(layout);
  await writeSettingsFile(layout,newSettingsFile({environment:'test'}));
  const calls:Array<{command:string;args:readonly string[];options?:CommandOptions}>=[];
  const context=createContext({CIRCLE_HUB_TOKEN:'synthetic-sensitive-never-child'}, {layout,platform,home:root,user:'synthetic',uid:501,
    runner:async(command,args,options)=>{calls.push({command,args,options});return {code:0,stdout:'',stderr:''};}});
  const config=loadServerConfig(serviceEnvironment(layout,await settingsOf(context),identityOf(context)));
  return {root,context,config,calls,id:'550e8400-e29b-41d4-a716-446655440000'};
}
test('Linux supervisor launch fixes Node/CLI/UUID and excludes parent token material',async t=>{
  const f=await supervisorFixture(t,'linux');
  await launchDeploymentSyncSupervisor(f.config,f.id,f.context);
  assert.equal(f.calls.length,1);const call=f.calls[0];
  assert.equal(call.command,'/usr/bin/systemd-run');
  assert.deepEqual(call.args.slice(-5),[process.execPath,join(CODE_ROOT,'bin','circle-hub'),'knowledge','sync-worker',f.id]);
  assert.ok(call.args.includes('--property=Type=exec'));assert.ok(call.args.includes('--property=StandardOutput=null'));
  assert.ok(!JSON.stringify(call).includes('synthetic-sensitive-never-child'));
  assert.equal(call.options?.env?.XDG_RUNTIME_DIR,'/run/user/501');
});
test('macOS supervisor is a one-shot independent launchd job',async t=>{
  const f=await supervisorFixture(t,'darwin');
  await launchDeploymentSyncSupervisor(f.config,f.id,f.context);
  assert.equal(f.calls[0].command,'/bin/launchctl');
  const plist=await readFile(join(f.root,'run','deployment-sync',f.id+'.plist'),'utf8');
  assert.match(plist,/<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist,/<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(plist.includes('sync-worker'));assert.ok(!plist.includes('synthetic-sensitive-never-child'));
});
test('supervisor refuses an arbitrary id or a different database before any OS command',async t=>{
  const f=await supervisorFixture(t,'linux');
  await assert.rejects(launchDeploymentSyncSupervisor(f.config,'../escape',f.context));
  await assert.rejects(launchDeploymentSyncSupervisor({...f.config,database:{...f.config.database,database:'another'}},f.id,f.context),/不一致/);
  assert.equal(f.calls.length,0);
});

test('offline owner submission may launch the same database runtime worker without widening its DSN',async t=>{
  const f=await supervisorFixture(t,'linux');
  await launchDeploymentSyncSupervisor({...f.config,database:{...f.config.database,user:f.context.user}},f.id,f.context);
  assert.equal(f.calls.length,1);
  assert.ok(f.calls[0].args.includes('--setenv=CIRCLE_HUB_DATABASE_USER='+f.context.database.role));
  assert.ok(!f.calls[0].args.includes('--setenv=CIRCLE_HUB_DATABASE_USER='+f.context.user));
});

import { deploymentSyncReportCoversLine } from './deployment-sync.ts';
test('an unchanged report for another line never covers the explicit requested line',()=>{
  const other=probe();
  assert.equal(unchangedDeploymentProbe(other,'synthetic-line'),true);
  assert.equal(unchangedDeploymentProbe(other,'missing-line'),false);
  assert.equal(unchangedDeploymentProbe(other,null),true);
  assert.equal(deploymentSyncReportCoversLine(other,'missing-line'),false);
  assert.equal(deploymentSyncReportCoversLine(other,'synthetic-line '),false);
  assert.equal(deploymentSyncReportCoversLine(other,'SYNTHETIC-LINE'),false);
  assert.equal(deploymentSyncReportCoversLine(other,'synthetic-line'),true);
  assert.equal(deploymentSyncReportCoversLine(other,null),true);
});
test('actual synchronization also requires target coverage while a null selection imposes no line match',()=>{
  const actual=probe();actual.dry_run=false;
  actual.builds[0].outcome='produced';
  assert.equal(deploymentSyncReportCoversLine(actual,'missing-line'),false);
  assert.equal(deploymentSyncReportCoversLine(actual,'synthetic-line'),true);
  actual.builds=[];
  assert.equal(deploymentSyncReportCoversLine(actual,'synthetic-line'),false);
  assert.equal(deploymentSyncReportCoversLine(actual,null),true);
});
