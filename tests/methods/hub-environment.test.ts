import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {assertHubEnvironment,retiredHubEnvironmentKeys} from '../../packages/contracts/src/hub-environment.ts';

const root=new URL('../../',import.meta.url);
function cleanEnvironment(){const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('CIRCLE_HUB_')||key.startsWith('CIRCLE_SERVER_'))delete env[key];return env;}
function invoke(values:NodeJS.ProcessEnv){return spawnSync(process.execPath,['--input-type=module','-e',`await import('./packages/contracts/src/hub-environment.ts'); console.log(JSON.stringify({token:process.env.CIRCLE_HUB_TOKEN,port:process.env.CIRCLE_HUB_PORT,empty:process.env.CIRCLE_HUB_DATA_DIR}));`],{cwd:root,env:{...cleanEnvironment(),...values},encoding:'utf8'});}
test('Hub environment: a retired CIRCLE_SERVER input refuses startup, names each replacement and never echoes values',()=>{
 const result=invoke({CIRCLE_SERVER_TOKEN:'synthetic-private-token',CIRCLE_SERVER_PORT:'7410',CIRCLE_HUB_PORT:'7420',CIRCLE_SERVER_DATA_DIR:''});
 assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.match(result.stderr,/HubEnvironmentError/);
 for(const suffix of ['DATA_DIR','PORT','TOKEN'])assert.ok(result.stderr.includes(`CIRCLE_SERVER_${suffix} -> CIRCLE_HUB_${suffix}`),suffix);
 for(const value of ['synthetic-private-token','7410','7420'])assert.ok(!result.stderr.includes(value),value);
});
test('Hub environment: the check never aliases or rewrites input and treats only present keys as retired',()=>{
 const environment:NodeJS.ProcessEnv={CIRCLE_SERVER_EXECUTION_GATEWAYS:'synthetic-old-profile',CIRCLE_HUB_EXECUTION_GATEWAYS:'synthetic-new-profile',CIRCLE_SERVER_POLL_MS:undefined},before={...environment};
 assert.deepEqual(retiredHubEnvironmentKeys(environment),['CIRCLE_SERVER_EXECUTION_GATEWAYS']);
 assert.throws(()=>assertHubEnvironment(environment),(error:any)=>error.name==='HubEnvironmentError'&&error.message.includes('CIRCLE_SERVER_EXECUTION_GATEWAYS -> CIRCLE_HUB_EXECUTION_GATEWAYS')&&!error.message.includes('synthetic-'));
 assert.deepEqual(environment,before);
 const legacyOnly:NodeJS.ProcessEnv={CIRCLE_SERVER_TOKEN:'synthetic-old-token'};assert.throws(()=>assertHubEnvironment(legacyOnly),{name:'HubEnvironmentError'});assert.equal(legacyOnly.CIRCLE_HUB_TOKEN,undefined);
 assert.doesNotThrow(()=>assertHubEnvironment({CIRCLE_HUB_TOKEN:'synthetic-new-token',CIRCLE_SERVERLESS:'unrelated'}));
});
test('Hub environment: new-only configuration emits nothing and initializes before modules that capture environment values',()=>{
 const result=invoke({CIRCLE_HUB_TOKEN:'synthetic-new-token',CIRCLE_HUB_PORT:'7430'});assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{token:'synthetic-new-token',port:'7430'});
 const ordering=spawnSync(process.execPath,['--input-type=module','-e',`import './packages/contracts/src/hub-environment.ts'; import {eventRetention} from './packages/tasks/src/outbox-retention.ts'; console.log(JSON.stringify(eventRetention));`],{cwd:root,env:{...cleanEnvironment(),CIRCLE_HUB_OUTBOX_MAX_ROWS:'23',CIRCLE_HUB_OUTBOX_REPLAY_EVENTS:'7'},encoding:'utf8'});assert.equal(ordering.status,0,ordering.stderr);const captured=JSON.parse(ordering.stdout);assert.equal(captured.maxRows,23);assert.equal(captured.replayEvents,7);
});
test('Hub environment: every hub entry point refuses a retired input beside valid new configuration before doing any work',()=>{
 const entries=[['apps/server/src/main.ts'],['apps/server/src/supervisor.ts'],['apps/worker/src/main.ts'],['apps/server/src/cli.ts','admin','tasks'],['bin/circle-hub','modules','check'],['scripts/dev-stack.ts'],['scripts/postgres-process.ts'],['scripts/verify-postgres.ts']];
 for(const entry of entries){
  const run=spawnSync(process.execPath,entry,{cwd:root,env:{...cleanEnvironment(),CIRCLE_HUB_URL:'http://127.0.0.1:9',CIRCLE_HUB_PORT:'0',CIRCLE_HUB_TOKEN:'synthetic-new-token',CIRCLE_SERVER_DATABASE_CONFIG:'synthetic-database-secret'},encoding:'utf8',timeout:20_000});
  assert.equal(run.error,undefined,entry[0]);assert.equal(run.status,1,`${entry[0]}: ${run.stderr}`);assert.equal(run.stdout,'',entry[0]);
  assert.ok(run.stderr.includes('CIRCLE_SERVER_DATABASE_CONFIG -> CIRCLE_HUB_DATABASE_CONFIG'),entry[0]);assert.ok(!run.stderr.includes('synthetic-database-secret'),entry[0]);assert.ok(!run.stderr.includes('synthetic-new-token'),entry[0]);
 }
});
