import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {THEME_SCRIPT_HASH,CONTENT_SECURITY_POLICY,secureConsoleResponse,page,html,liveModule} from './console/html.ts';
import {CONSOLE_THEME,CONSOLE_LIVE,CONSOLE_CSS} from './console/assets.ts';

function check(body:string,policy:string){
 const nonce=/script-src 'nonce-([A-Za-z0-9+/]{24})' 'sha256-([A-Za-z0-9+/=]+)'(?:;|$)/.exec(policy);assert.ok(nonce);assert.equal(nonce[2],THEME_SCRIPT_HASH);
 assert.equal(policy.replace(` 'nonce-${nonce[1]}'`,''),CONTENT_SECURITY_POLICY);
 assert.doesNotMatch(policy,/unsafe|\*|script-src[^;]*'self'/);
 const scripts=[...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
 assert.ok(scripts.length>=2);assert.doesNotMatch(scripts[0][1],/nonce=/);
 for(const script of scripts.slice(1)){assert.ok(script[1].includes(`nonce="${nonce[1]}"`));assert.equal(script[2],'');const value=script[1].includes(CONSOLE_THEME.path)?CONSOLE_THEME:CONSOLE_LIVE;assert.ok(script[1].includes(`src="${value.path}"`));assert.ok(script[1].includes(`integrity="${value.integrity}"`));}
 assert.ok(body.includes(`href="${CONSOLE_CSS.path}"`));return nonce[1];
}
test('response nonces grant only fixed external SRI tags and preserve the pre-paint hash and authorization form target',()=>{
 const template=page({title:'合成设置',user:null,csrf:null,wide:true},liveModule('synthetic',['task.updated'],html`<p>合成页面</p>`));
 const a=secureConsoleResponse(template),b=secureConsoleResponse(template);assert.notEqual(check(a.text,a.policy),check(b.text,b.policy));
 assert.ok(a.text.indexOf('<script data-console-theme>')<a.text.indexOf('<link rel="stylesheet"'));
 const custom=secureConsoleResponse(template,CONTENT_SECURITY_POLICY.replace("form-action 'self'","form-action 'self' https://example.com"));assert.ok(custom.policy.includes("form-action 'self' https://example.com"));
});
test('login, signed-in live pages and errors get fresh matching response nonces without changing cached assets',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,requireOsIsolation:false});t.after(()=>hub.close());const client=await openConsole(hub,hub.admin.token),seen=new Set<string>();
 for(const path of ['/console/login','/console/login','/console/overview','/console/not-a-page']){
  const reply=await client.get(path);assert.equal(reply.status,path.endsWith('not-a-page')?404:200);const nonce=check(reply.body,String(reply.headers['content-security-policy']));assert.ok(!seen.has(nonce));seen.add(nonce);assert.equal(Number(reply.headers['content-length']),Buffer.byteLength(reply.body));
 }
 for(const value of [CONSOLE_THEME,CONSOLE_LIVE]){const reply=await client.get(value.path);assert.equal(reply.status,200);assert.equal(reply.body,value.body);assert.match(String(reply.headers['cache-control']),/immutable/);assert.doesNotMatch(reply.body,/nonce=/);}
});
