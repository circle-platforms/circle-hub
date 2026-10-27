// Only scratch PostgreSQL, file key provider and an in-memory operator token; no system credential store.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openCliHarness} from './test-cli.ts';
import {adminCommands} from '../cli-admin.ts';
import {createAssembly,createCommandAssembly} from './hub.ts';
import {memoryOperatorTokens} from './operator-token.ts';
import {openRecords} from '../../records/index.ts';
import {loadServerConfig} from '../main.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {runRecord} from '../../../contracts/src/fixtures.ts';
import {newId} from '../../records/api.ts';
import {manifestDigest} from '../../runs/api.ts';
import type {AssemblyModule} from '../api.ts';
test('skill bind-legacy resolves and displays a published digest and appends an authenticated migration declaration',async t=>{
 const harness=await openCliHarness();t.after(()=>harness.close());const deployment=await harness.deployment();
 const tokens=memoryOperatorTokens(null,'合成内存令牌'),options={tokens:()=>tokens,assembly:{requireOsIsolation:false}};
 const module:AssemblyModule={assemble:createAssembly(options.assembly),assembleCommand:createCommandAssembly(options.assembly),registerCommands:register=>adminCommands(options).forEach(register)};
 const run=(argv:string[],env:Record<string,string>={})=>deployment.run(argv,{assembly:async()=>module,operatorTokens:()=>tokens},env);
 assert.equal((await run(['init-admin','合成管理员'])).code,0);
 assert.equal((await run(['pack','grant-publish','合成管理员'])).code,0);
 const source=new URL('../../../packs/skill/mindmap-format/',import.meta.url);
 const published=await run(['pack','publish',fileURLToPath(source),'--stage']);assert.equal(published.code,0,published.text);
 const digest=manifestDigest(JSON.parse(await readFile(new URL('pack.json',source),'utf8')));
 const kit=await openRecords(loadServerConfig(deployment.env),{migrate:false,keyProvider:deployment.key});t.after(()=>kit.close());
 const historical:ReturnType<typeof RunRecord.parse>[]=[];
 for(let index=0;index<2;index++){const body=RunRecord.parse({...runRecord,run:newId('run'),skills:undefined,items:runRecord.items.map(item=>({...item,location:`src:${'a'.repeat(64)}/kityminder@1/n/synthetic`}))});historical.push(body);await kit.store.put({kind:'run',schema:'run@1',provenance:'projected',body,index:[{key:'runs.id',value:body.run}]});}
 const result=await run(['skill','bind-legacy','kityminder@1','mindmap-format@1.0.2']);assert.equal(result.code,0,result.text);assert.ok(result.text.includes(digest));assert.match(result.text,/迁移时点事后声明/);assert.match(result.text,/追加绑定 2 条/);assert.match(result.text,/mindmap-format migration equivalence across repository documents/);
 const rows=await kit.store.find<any>({kind:'action',key:'refs.legacy-parser',value:'kityminder@1',limit:10});assert.equal(rows.items.length,1);const record=rows.items[0];assert.equal(record.provenance,'declared');assert.equal(record.body.detail.migration.skill.digest,digest);assert.equal(record.body.detail.migration.decided_by,(await kit.principals.findByName('合成管理员'))!.id);
 for(const body of historical){const bindings=await kit.store.find<any>({kind:'action',key:'runs.skills',value:body.run,limit:10});assert.equal(bindings.items.length,1);assert.equal(bindings.items[0].body.detail.skills[0].digest,digest);assert.equal(bindings.items[0].body.detail.test,record.body.detail.migration.test);}
 const user=await kit.principals.createUser((await kit.principals.findByName('合成管理员'))!,'合成用户');const token=(await kit.principals.issueToken((await kit.principals.findByName('合成管理员'))!,user.id,'synthetic')).token;
 assert.equal((await run(['skill','bind-legacy','kityminder@1','mindmap-format@1.0.2'],{CIRCLE_HUB_TOKEN:token})).code,1);assert.equal((await kit.store.find({kind:'action',key:'refs.legacy-parser',value:'kityminder@1',limit:10})).items.length,1);
});

test('skill bind-legacy appends migration declaration for xlsx@1 using workbook-format',async t=>{
 const harness=await openCliHarness();t.after(()=>harness.close());const deployment=await harness.deployment();
 const tokens=memoryOperatorTokens(null,'合成内存令牌'),options={tokens:()=>tokens,assembly:{requireOsIsolation:false}};
 const module:AssemblyModule={assemble:createAssembly(options.assembly),assembleCommand:createCommandAssembly(options.assembly),registerCommands:register=>adminCommands(options).forEach(register)};
 const run=(argv:string[],env:Record<string,string>={})=>deployment.run(argv,{assembly:async()=>module,operatorTokens:()=>tokens},env);
 assert.equal((await run(['init-admin','合成管理员'])).code,0);
 assert.equal((await run(['pack','grant-publish','合成管理员'])).code,0);
 const source=new URL('../../../packs/skill/workbook-format/',import.meta.url);
 const published=await run(['pack','publish',fileURLToPath(source),'--stage']);assert.equal(published.code,0,published.text);
 const digest=manifestDigest(JSON.parse(await readFile(new URL('pack.json',source),'utf8')));
 const kit=await openRecords(loadServerConfig(deployment.env),{migrate:false,keyProvider:deployment.key});t.after(()=>kit.close());
 const historical:ReturnType<typeof RunRecord.parse>[]=[];
 for(let index=0;index<2;index++){
   const body=RunRecord.parse({...runRecord,run:newId('run'),skills:undefined,items:runRecord.items.map(item=>({...item,location:`src:${'b'.repeat(64)}/xlsx@1/c/Sheet1/A1`}))});
   historical.push(body);
   await kit.store.put({kind:'run',schema:'run@1',provenance:'projected',body,index:[{key:'runs.id',value:body.run}]});
 }
 const result=await run(['skill','bind-legacy','xlsx@1','workbook-format@1.0.3']);assert.equal(result.code,0,result.text);assert.ok(result.text.includes(digest));assert.match(result.text,/迁移时点事后声明/);assert.match(result.text,/追加绑定 2 条/);assert.match(result.text,/workbook-format migration equivalence across repository documents/);
 const rows=await kit.store.find<any>({kind:'action',key:'refs.legacy-parser',value:'xlsx@1',limit:10});assert.equal(rows.items.length,1);const record=rows.items[0];assert.equal(record.provenance,'declared');assert.equal(record.body.detail.migration.skill.digest,digest);assert.equal(record.body.detail.migration.decided_by,(await kit.principals.findByName('合成管理员'))!.id);
 for(const body of historical){
   const bindings=await kit.store.find<any>({kind:'action',key:'runs.skills',value:body.run,limit:10});
   assert.equal(bindings.items.length,1);
   assert.equal(bindings.items[0].body.detail.skills[0].digest,digest);
   assert.equal(bindings.items[0].body.detail.test,record.body.detail.migration.test);
 }
});

test('skill bind-legacy appends migration declaration for xml@1 using xml-format',async t=>{
 const harness=await openCliHarness();t.after(()=>harness.close());const deployment=await harness.deployment();
 const tokens=memoryOperatorTokens(null,'合成内存令牌'),options={tokens:()=>tokens,assembly:{requireOsIsolation:false}};
 const module:AssemblyModule={assemble:createAssembly(options.assembly),assembleCommand:createCommandAssembly(options.assembly),registerCommands:register=>adminCommands(options).forEach(register)};
 const run=(argv:string[],env:Record<string,string>={})=>deployment.run(argv,{assembly:async()=>module,operatorTokens:()=>tokens},env);
 assert.equal((await run(['init-admin','合成管理员'])).code,0);
 assert.equal((await run(['pack','grant-publish','合成管理员'])).code,0);
 const source=new URL('../../../packs/skill/xml-format/',import.meta.url);
 const published=await run(['pack','publish',fileURLToPath(source),'--stage']);assert.equal(published.code,0,published.text);
 const digest=manifestDigest(JSON.parse(await readFile(new URL('pack.json',source),'utf8')));
 const kit=await openRecords(loadServerConfig(deployment.env),{migrate:false,keyProvider:deployment.key});t.after(()=>kit.close());
 const historical:ReturnType<typeof RunRecord.parse>[]=[];
 for(let index=0;index<2;index++){
   const body=RunRecord.parse({...runRecord,run:newId('run'),skills:undefined,items:runRecord.items.map(item=>({...item,location:`src:${'c'.repeat(64)}/xml@1/x/commands/item`}))});
   historical.push(body);
   await kit.store.put({kind:'run',schema:'run@1',provenance:'projected',body,index:[{key:'runs.id',value:body.run}]});
 }
 const result=await run(['skill','bind-legacy','xml@1','xml-format@1.0.3']);assert.equal(result.code,0,result.text);assert.ok(result.text.includes(digest));assert.match(result.text,/迁移时点事后声明/);assert.match(result.text,/追加绑定 2 条/);assert.match(result.text,/xml-format migration equivalence across repository documents/);
 const rows=await kit.store.find<any>({kind:'action',key:'refs.legacy-parser',value:'xml@1',limit:10});assert.equal(rows.items.length,1);const record=rows.items[0];assert.equal(record.provenance,'declared');assert.equal(record.body.detail.migration.skill.digest,digest);assert.equal(record.body.detail.migration.decided_by,(await kit.principals.findByName('合成管理员'))!.id);
 for(const body of historical){
   const bindings=await kit.store.find<any>({kind:'action',key:'runs.skills',value:body.run,limit:10});
   assert.equal(bindings.items.length,1);
   assert.equal(bindings.items[0].body.detail.skills[0].digest,digest);
   assert.equal(bindings.items[0].body.detail.test,record.body.detail.migration.test);
 }
});

test('skill bind-legacy appends migration declaration for html@1 using html-format',async t=>{
 const harness=await openCliHarness();t.after(()=>harness.close());const deployment=await harness.deployment();
 const tokens=memoryOperatorTokens(null,'合成内存令牌'),options={tokens:()=>tokens,assembly:{requireOsIsolation:false}};
 const module:AssemblyModule={assemble:createAssembly(options.assembly),assembleCommand:createCommandAssembly(options.assembly),registerCommands:register=>adminCommands(options).forEach(register)};
 const run=(argv:string[],env:Record<string,string>={})=>deployment.run(argv,{assembly:async()=>module,operatorTokens:()=>tokens},env);
 assert.equal((await run(['init-admin','合成管理员'])).code,0);
 assert.equal((await run(['pack','grant-publish','合成管理员'])).code,0);
 const source=new URL('../../../packs/skill/html-format/',import.meta.url);
 const published=await run(['pack','publish',fileURLToPath(source),'--stage']);assert.equal(published.code,0,published.text);
 const digest=manifestDigest(JSON.parse(await readFile(new URL('pack.json',source),'utf8')));
 const kit=await openRecords(loadServerConfig(deployment.env),{migrate:false,keyProvider:deployment.key});t.after(()=>kit.close());
 const historical:ReturnType<typeof RunRecord.parse>[]=[];
 for(let index=0;index<2;index++){
   const body=RunRecord.parse({...runRecord,run:newId('run'),skills:undefined,items:runRecord.items.map(item=>({...item,location:`src:${'d'.repeat(64)}/html@1/b/0`}))});
   historical.push(body);
   await kit.store.put({kind:'run',schema:'run@1',provenance:'projected',body,index:[{key:'runs.id',value:body.run}]});
 }
 const result=await run(['skill','bind-legacy','html@1','html-format@1.0.2']);assert.equal(result.code,0,result.text);assert.ok(result.text.includes(digest));assert.match(result.text,/迁移时点事后声明/);assert.match(result.text,/追加绑定 2 条/);assert.match(result.text,/html-format migration equivalence across repository documents/);
 const rows=await kit.store.find<any>({kind:'action',key:'refs.legacy-parser',value:'html@1',limit:10});assert.equal(rows.items.length,1);const record=rows.items[0];assert.equal(record.provenance,'declared');assert.equal(record.body.detail.migration.skill.digest,digest);assert.equal(record.body.detail.migration.decided_by,(await kit.principals.findByName('合成管理员'))!.id);
 for(const body of historical){
   const bindings=await kit.store.find<any>({kind:'action',key:'runs.skills',value:body.run,limit:10});
   assert.equal(bindings.items.length,1);
   assert.equal(bindings.items[0].body.detail.skills[0].digest,digest);
   assert.equal(bindings.items[0].body.detail.test,record.body.detail.migration.test);
 }
});
