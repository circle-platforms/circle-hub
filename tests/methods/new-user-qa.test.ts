import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {ApiError} from '../../packages/contracts/src/index.ts';
import {NODE_INSTALL_URL,REQUIRED_NODE_MAJOR,assertHubPort,assertNodeEngine} from '../../packages/contracts/src/hub-environment.ts';
import {isolatedProcess} from '../../packages/runtime/src/isolation.ts';
import {assertInstalledCapability,phaseLabel} from '../../packages/tasks/src/index.ts';
import {devStackNextLines,devStackSecret} from '../../scripts/dev-stack-options.ts';

test('Node engine check names Node.js 24 and the install page without reading configuration',()=>{
 assert.equal(REQUIRED_NODE_MAJOR,24);
 assert.doesNotThrow(()=>assertNodeEngine('24.0.0'));
 assert.throws(()=>assertNodeEngine('22.14.0'),(error:any)=>error.name==='HubEnvironmentError'&&error.message.includes('Node.js 24')&&error.message.includes('22.14.0')&&error.message.includes(NODE_INSTALL_URL)&&error.message.includes('package.json engines'));
});
test('CIRCLE_HUB_PORT accepts 0 through 65535 and rejects other values without echoing them',()=>{
 assert.doesNotThrow(()=>assertHubPort({}));
 assert.doesNotThrow(()=>assertHubPort({CIRCLE_HUB_PORT:'0'}));
 assert.doesNotThrow(()=>assertHubPort({CIRCLE_HUB_PORT:'8080'}));
 assert.throws(()=>assertHubPort({CIRCLE_HUB_PORT:'65536'}),(error:any)=>error.name==='HubEnvironmentError'&&error.message.includes('CIRCLE_HUB_PORT')&&!error.message.includes('65536'));
 assert.throws(()=>assertHubPort({CIRCLE_HUB_PORT:'not-a-port'}),(error:any)=>error.name==='HubEnvironmentError'&&!error.message.includes('not-a-port'));
});
test('allowScripts explicitly covers every locked package that has an install script',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
 const lock=JSON.parse(await readFile(new URL('../../package-lock.json',import.meta.url),'utf8'));
 const required=[];
 for(const [path,meta] of Object.entries<any>(lock.packages??{}))if(meta?.hasInstallScript)required.push(`${path.slice('node_modules/'.length)}@${meta.version}`);
 assert.ok(required.length>=8);
 for(const key of required)assert.equal(manifest.allowScripts[key],true,key);
 assert.equal(manifest.allowScripts['embedded-postgres@18.4.0-beta.17'],undefined);
});
test('Capability packs name a missing id before any upload and keep retired ids on the old code',()=>{
 const installed=new Set(['mindmap-compile']);
 assert.doesNotThrow(()=>assertInstalledCapability(installed,undefined));
 assert.doesNotThrow(()=>assertInstalledCapability(installed,'mindmap-compile'));
 assert.throws(()=>assertInstalledCapability(installed,'not-a-real-pack'),(error:any)=>error instanceof ApiError&&error.code==='TARGET_NOT_FOUND'&&error.message.includes('not-a-real-pack')&&error.message.includes('GET /v1/packs')&&error.details.capabilityPackId==='not-a-real-pack');
 for(const id of ['lbx-healthcheck','apv-case-execute'])assert.throws(()=>assertInstalledCapability(installed,id),(error:any)=>error.code==='UNSUPPORTED_VERSION'&&error.message==='Capability package is not installed');
});
test('Linux sandbox refusal names the platform and the quickstart and does not mention a Mac executable path',async()=>{
 await assert.rejects(isolatedProcess(process.execPath,[],{read:[],write:[],network:[]}),(error:any)=>error.code==='SANDBOX_UNAVAILABLE'&&error.message.includes(process.platform)&&error.message.includes('docs/quickstart.md')&&error.message.includes('seatbelt')&&!error.message.includes('/usr/bin/'));
});
test('Development stack secrets stay random unless set, and the stop line follows the terminal',()=>{
 assert.equal(devStackSecret('CIRCLE_HUB_DEV_PASSWORD',undefined,'generated-secret'),'generated-secret');
 assert.equal(devStackSecret('CIRCLE_HUB_DEV_PASSWORD','','generated-secret'),'generated-secret');
 assert.equal(devStackSecret('CIRCLE_HUB_DEV_PASSWORD','synthetic-dev-password','generated-secret'),'synthetic-dev-password');
 assert.throws(()=>devStackSecret('CIRCLE_HUB_DEV_PASSWORD','too-short','generated-secret'),(error:any)=>error.name==='HubEnvironmentError'&&error.message.includes('CIRCLE_HUB_DEV_PASSWORD')&&!error.message.includes('too-short'));
 const background=devStackNextLines({url:'http://127.0.0.1:8080',userPassword:'developer-secret',approverPassword:'approver-secret',samplePath:'/tmp/synthetic-mindmap.xmind',pid:42,foreground:false});
 assert.ok(background.some(line=>line.includes('/extensions enable hub')));
 assert.ok(background.some(line=>line.includes('/hub login http://127.0.0.1:8080 developer')));
 assert.ok(background.some(line=>line.includes('SIGTERM')&&line.includes('42')));
 assert.equal(background.some(line=>line.includes('Ctrl+C')),false);
 assert.equal(background.some(line=>line.includes('POST /v1/auth/dev-login')),false);
 const foreground=devStackNextLines({url:'http://127.0.0.1:9',userPassword:'developer-secret',approverPassword:'approver-secret',samplePath:'sample',pid:7,foreground:true});
 assert.ok(foreground.some(line=>line.includes('Ctrl+C')));
});
test('Admitted tasks keep the protocol phase and add a plain label',()=>{
 assert.equal(phaseLabel('admitted'),'accepted, not started');
 assert.equal(phaseLabel('unknown'),'unknown; the hub does not guess the outcome');
});
