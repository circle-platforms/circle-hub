import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname} from 'node:path';
import {freezeModule,verifyModule} from '../../packages/modules/src/verify.ts';
import {ProductModules} from '../../packages/methods/src/product-modules.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
import {enforcementEnvironment} from '../fixtures/enforcement-environment.ts';
import {executionWorkbook} from '../fixtures/execution-workbook.ts';
const catalog=process.env.CIRCLE_PACKS_CATALOG??resolve('../circle-packs/modules.json');
async function sample(t:any){
  try{await access(catalog);}catch{t.skip('Set CIRCLE_PACKS_CATALOG to the independently versioned circle-packs catalog');return;}
  // The author continues working on main. Read the agreed sample commit rather
  // than changing bytes half way through a hub acceptance run.
  const git=promisify(execFile),commit=process.env.CIRCLE_PACKS_COMMIT??'ba06eed',root=dirname(catalog);
  const manifest=JSON.parse((await git('git',['-C',root,'show',`${commit}:modules.json`],{maxBuffer:16*1024*1024})).stdout),module=manifest.modules.find((entry:any)=>entry.id==='apv');assert.ok(module);
  const files=[];for(const file of module.files){const result=await git('git',['-C',root,'show',`${commit}:${module.root}/${file.path}`],{encoding:'buffer',maxBuffer:16*1024*1024});files.push({path:file.path,base64:result.stdout.toString('base64'),sha256:file.sha256});}
  return verifyModule(module,files);
}
const actor:any={principalId:'prn_fixture',tenantId:'ten_fixture',kind:'user'};
function loader(frozen:any){let approved=true;const sources:any={snapshot:async()=>{assert.ok(approved,'Draft cannot execute');return {assetId:'ast_fixture',assetVersion:frozen.module.version,assetSha256:frozen.module.digest,metadata:{module:frozen.module,manifest:frozen.manifest}};},bytes:async()=>frozen.files.map((file:any)=>({path:file.path,bytes:Buffer.from(file.base64,'base64')}))};return {modules:new ProductModules(sources),revoke:()=>{approved=false;}};}
test('R3 hooks: the canonical APV module is loaded unchanged and every reported test passes against hub dependencies',async t=>{
  const frozen=await sample(t);if(!frozen)return;const scratch=await mkdtemp(join(tmpdir(),'hub-pack-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
  for(const file of frozen.files){const path=join(scratch,file.path);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,Buffer.from(file.base64,'base64'));assert.equal(sha256(await readFile(path)),file.sha256);}
  await symlink(resolve('node_modules'),join(scratch,'node_modules'),'dir');await writeFile(join(scratch,'package.json'),JSON.stringify({type:'module'}));
  const child=spawn(process.execPath,['--test','--test-reporter=tap',...(await readdir(join(scratch,'tests'))).filter(path=>path.endsWith('.mjs')).map(path=>join(scratch,'tests',path))],{cwd:scratch,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT')),stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});assert.equal(await new Promise(resolve=>child.on('exit',resolve)),0,output);
  const summary=Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(match=>[match[1],Number(match[2])]));
  assert.ok(summary.tests>0,output);assert.equal(summary.pass,summary.tests,output);for(const key of ['fail','cancelled','skipped'])assert.equal(summary[key],0,output);t.diagnostic(`Frozen product-line ${frozen.module.id}@${frozen.module.version}: ${summary.pass}/${summary.tests}, no skipped or cancelled tests`);
  const {modules,revoke}=loader(frozen),binding={method:'fixture',resource:{assetId:'ast_fixture',version:'1.0.0',sha256:'a'.repeat(64),declaration:{allowedTestHosts:['fixture']}},source:'sar_fixture',inputRevision:'inrev_fixture'};
  const workbook=await executionWorkbook({command:'service inspect alpha'}),parsed=await modules.call(actor,'ast_fixture','scp_fixture','tools/workbook.ts','readExecutionWorkbook',[workbook]);assert.equal(parsed.sha256,sha256(workbook));assert.equal(parsed.commands[0].command,'service inspect alpha');
  const blocked=await modules.run(actor,'ast_fixture','scp_fixture','verify.deviceCommand',binding,{command:'missing',tree:{heads:[]}});assert.equal(blocked[0].result.code,'COMMAND_NOT_IN_TREE');assert.equal(blocked[0].ruleVersion,frozen.module.version);revoke();await assert.rejects(modules.load(actor,'ast_fixture','scp_fixture'));
});
test('R3 hooks: zero handlers dispatch then the approved canonical APV handlers block the same workbook',async t=>{
  const frozen=await sample(t);if(!frozen)return;const {h,gateway,submit,payload}=await enforcementEnvironment(t,false,false);await h.startWorker();const unchecked=await submit('invented command 999','zero-handlers');await h.phase(unchecked.taskId,'delivered');assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  const response=await h.raw('/v1/modules/install',{token:await h.login('admin'),body:{module:frozen.module,files:frozen.files},headers:{'x-scope-id':'scp_lab'}});assert.equal(response.status,201,JSON.stringify(response.body));const asset=await h.request(`/v1/assets/${response.body.data.assetId}`,undefined,'admin');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');
  const input:any=await payload('invented command 999','approved-handlers');input.input.methodAssetId=asset.assetId;const checked=await h.request('/v1/tasks/submit',input);await h.phase(checked.taskId,'failed');const result=await h.request(`/v1/tasks/${checked.taskId}/result`);assert.equal(result.error.code,'COMMAND_NOT_IN_TREE');assert.equal(result.error.details.ruleId,'apv.hooks.device-command-tree');assert.equal(result.error.details.ruleVersion,frozen.module.version);assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  const events=await h.request(`/v1/tasks/${checked.taskId}/events?after=0`);assert.ok(events.events.some((event:any)=>event.kind==='hook.verification'&&event.payload.ruleVersion===frozen.module.version));
});
test('R3 hooks: a second product line loads its Tool imports and all five hook points without core changes',async()=>{
  const root=resolve('packs/meridian'),files:any[]=[];
  async function walk(dir:string,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const path=prefix+entry.name;if(entry.isDirectory())await walk(join(dir,entry.name),path+'/');else{const bytes=await readFile(join(dir,entry.name));files.push({path,base64:bytes.toString('base64'),sha256:sha256(bytes)});}}}await walk(root);files.sort((a,b)=>a.path<b.path?-1:1);const manifest=JSON.parse(await readFile(join(root,'product-line.json'),'utf8')),module={id:manifest.id,kind:'product-line',root:'products/meridian',manifestPath:'products/meridian/product-line.json',version:manifest.version,files:files.map(({path,sha256})=>({path,sha256})),digest:sha256(files.map(file=>`${file.sha256}  ${file.path}\n`).join(''))};const frozen=verifyModule(module,files),{modules}=loader(frozen);
  const loaded=await modules.load(actor,'ast_fixture','scp_fixture');assert.equal(loaded.handlers.length,5);assert.ok(loaded.manifest.resources.length);assert.ok(loaded.flows.length);for(const handler of loaded.handlers){const result=await modules.run(actor,'ast_fixture','scp_fixture',handler.event,{method:{deny:true},resource:{assetId:'ast_fixture',version:'1.0.0',sha256:'a'.repeat(64),declaration:{allowedTestHosts:['fixture']}},source:'fixture',inputRevision:'inrev_fixture'},handler.event==='verify.deviceCommand'?{command:'fixture',tree:{heads:[]}}:handler.event==='verify.hostCommand'?{command:'fixture',host:'fixture',method:'fixture',kwargs:{}}:handler.event==='verify.workbook'?{client:'fixture',contract:{testEnvEnabled:[]}}:handler.event==='beforeDispatch'?{input:{},operationId:'op_fixture'}:{result:{},operationId:'op_fixture'});assert.equal(result[0].result.code,'FIXTURE_BLOCKED');assert.equal(result[0].ruleVersion,'1.0.0');}
  assert.deepEqual(await modules.call(actor,'ast_fixture','scp_fixture','tools/project.ts','project',[{label:'literal',revision:'1'}]), {label:'literal',revision:'1'});
});
