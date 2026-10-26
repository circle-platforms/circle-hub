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
 const result=await run(['skill','bind-legacy','kityminder@1','mindmap-format@1.0.0']);assert.equal(result.code,0,result.text);assert.ok(result.text.includes(digest));assert.match(result.text,/迁移时点事后声明/);assert.match(result.text,/mindmap-format migration equivalence across repository documents/);
 const kit=await openRecords(loadServerConfig(deployment.env),{migrate:false,keyProvider:deployment.key});t.after(()=>kit.close());
 const rows=await kit.store.find<any>({kind:'action',key:'refs.legacy-parser',value:'kityminder@1',limit:10});assert.equal(rows.items.length,1);const record=rows.items[0];assert.equal(record.provenance,'declared');assert.equal(record.body.detail.migration.skill.digest,digest);assert.equal(record.body.detail.migration.decided_by,(await kit.principals.findByName('合成管理员'))!.id);
 const user=await kit.principals.createUser((await kit.principals.findByName('合成管理员'))!,'合成用户');const token=(await kit.principals.issueToken((await kit.principals.findByName('合成管理员'))!,user.id,'synthetic')).token;
 assert.equal((await run(['skill','bind-legacy','kityminder@1','mindmap-format@1.0.0'],{CIRCLE_HUB_TOKEN:token})).code,1);assert.equal((await kit.store.find({kind:'action',key:'refs.legacy-parser',value:'kityminder@1',limit:10})).items.length,1);
});
