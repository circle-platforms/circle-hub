// Opt-in Linux-only synthetic lifecycle: a unique user unit, a loopback server, and temporary PostgreSQL roots.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {homedir, userInfo} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {createBackup,verifyBackup} from './backup.ts';
import {agentFor,createContext,postgresFor} from './context.ts';
import {deploy,rollback,systemDeployHost} from './deploy.ts';
import {ensureLayout,layoutAt} from './layout.ts';
import {createPostgres,ensureDatabaseRunning} from './postgres.ts';
import {runCommand,type CommandRunner} from './process.ts';
import {readCurrentRelease} from './release.ts';
import {restoreBackup} from './restore.ts';
import {newSettingsFile,resolveSettings,writeSettingsFile} from './settings.ts';
import {defaultSystemdDirectory} from './systemd.ts';
import {withSession} from './sql.ts';
import {freePort,libpqAvailable,LIBPQ_MISSING,ownerTables,removeDir,socketPort,tempDir} from './test-support.ts';
const tree=fileURLToPath(new URL('../../',import.meta.url));
const libpq=await libpqAvailable();
const enabled=process.platform==='linux' && process.env.HUB_TEST_SYSTEMD_REAL==='1';
const bin=`#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {userInfo} from 'node:os';
import pg from 'pg';
const e=process.env, id=JSON.parse(readFileSync(new URL('../release.json',import.meta.url),'utf8')).id;
if(process.argv.includes('--migrate-only')){
 const c=new pg.Client({host:e.CIRCLE_HUB_DATABASE_SOCKET_DIR,port:Number(e.CIRCLE_HUB_DATABASE_PORT),database:e.CIRCLE_HUB_DATABASE_NAME,user:userInfo().username});await c.connect();
 await c.query('CREATE TABLE IF NOT EXISTS synthetic_migrations (release text NOT NULL)');await c.query('INSERT INTO synthetic_migrations VALUES ($1)',[id]);await c.query('GRANT SELECT, INSERT ON synthetic_migrations TO "'+e.CIRCLE_HUB_DATABASE_USER+'"');await c.end();
}else{createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',release:id}));}).listen(Number(e.CIRCLE_HUB_PORT),'127.0.0.1');}
`;
async function source(parent:string,version:string){const root=join(parent,`source-${version}`);await mkdir(join(root,'bin'),{recursive:true});await writeFile(join(root,'package.json'),'{"name":"synthetic-release","type":"module"}\n');await writeFile(join(root,'package-lock.json'),'{"lockfileVersion":3}\n');await writeFile(join(root,'VERSION'),version+'\n');await writeFile(join(root,'bin','circle-hub'),bin,{mode:0o755});return {path:root,copy:true};}

test('Linux synthetic deploy, backup, empty-root restore, verification and rollback use the real user manager', {skip:!enabled ? 'requires isolated Linux VM and HUB_TEST_SYSTEMD_REAL=1' : !libpq ? LIBPQ_MISSING : false,timeout:180_000},async()=>{
 const parent=await tempDir(),layout=layoutAt(join(parent,'root')),other=layoutAt(join(parent,'restore'));
 const label='circle-hub-synthetic-lifecycle-'+randomBytes(8).toString('hex'), port=await freePort(),dbPort=socketPort();
 const runner:CommandRunner=async(command,args,options={})=>{if(command==='npm'){await symlink(join(tree,'node_modules'),join(options.cwd!,'node_modules'));return {code:0,stdout:'',stderr:''};}return runCommand(command,args,options);};
 const env={CIRCLE_HUB_DATA_DIR:layout.root};
 const context=createContext(env,{layout,platform:'linux',home:homedir(),user:userInfo().username,uid:process.getuid!(),runner,launchAgentsDir:defaultSystemdDirectory(homedir()),nodePath:process.execPath,libpqBin:libpq,codeRoot:tree,healthTimeoutMs:15000,database:{name:'circle_hub',role:'circle_hub',port:dbPort}});
 const target=createPostgres({layout:other,port:dbPort});
 const definition=newSettingsFile({environment:'test',port,database:{port:dbPort}});const settings={...resolveSettings(definition,env,layout),label};
 const agent=agentFor(context,settings);
 const preexisting = await agent.status();
 assert.equal(preexisting.installed, false, 'refuse a pre-existing synthetic unit before cleanup is armed');
 assert.equal(preexisting.loaded, false, 'refuse a loaded synthetic unit before cleanup is armed');
 try {
  await ensureLayout(layout);await writeSettingsFile(layout,definition);
  const control=postgresFor(context);await control.initialise();await ensureDatabaseRunning(control,{create:true});
  await ownerTables(control,['CREATE TABLE synthetic_records (id integer PRIMARY KEY, value text NOT NULL)'],['synthetic_records']);
  await withSession(control.connector,control.target.database,s=>s.query("INSERT INTO synthetic_records VALUES (1,'synthetic')"));
  const v1source=await source(parent,'one');const first=await deploy(context,v1source,systemDeployHost(context,settings,v1source));
  assert.equal((await agent.status()).running,true);
  const current=await readCurrentRelease(layout);assert.equal(current?.id,first.release);
  const backup=await createBackup({layout,postgres:postgresFor(context,current?.dir),libpqBin:libpq,runner});await verifyBackup(backup.dir);
  const restored=await restoreBackup({layout:other,backupDir:backup.dir,postgres:target,libpqBin:libpq,runner});assert.ok(restored.rows>=1);
  assert.deepEqual(await withSession(target.connector,target.target.database,s=>s.query('SELECT id,value FROM synthetic_records')),[{id:1,value:'synthetic'}]);await target.stop();
  const v2source=await source(parent,'two');const second=await deploy(context,v2source,systemDeployHost(context,settings,v2source));assert.equal(second.previous,first.release);
  const back=await rollback(context,systemDeployHost(context,settings));assert.equal(back.release,first.release);
  assert.equal((await readCurrentRelease(layout))?.id,first.release);assert.equal((await agent.status()).running,true);
  const latest=postgresFor(context,(await readCurrentRelease(layout))?.dir);
  assert.deepEqual(await withSession(latest.connector,latest.target.database,s=>s.query('SELECT id,value FROM synthetic_records')),[{id:1,value:'synthetic'}]);
 } finally {
  await agent.uninstall().catch(()=>{spawnSync('/usr/bin/systemctl',['--user','disable','--now',`${label}.service`],{stdio:'ignore'});});
  await rm(agent.plist,{force:true});spawnSync('/usr/bin/systemctl',['--user','daemon-reload'],{stdio:'ignore'});
  await target.stop().catch(()=>{});await postgresFor(context,(await readCurrentRelease(layout).catch(()=>undefined))?.dir).stop().catch(()=>{});
  await removeDir(parent);
 }
});
