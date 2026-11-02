import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spaceLayout,inScope,knowledgeTabs} from './space-layout.ts';
import {html} from './html.ts';
import type {PageContext} from './pages.ts';
test('the shared panel groups only current authorized paths and keeps displayed directories slash-free',async()=>{
 const visible=[{space:'owner',paths:['/allowed'],version:{body:{directories:['/','/allowed','/allowed/child','/private'],products:[]}}}];
 const ctx={principal:{id:'reader'},url:new URL('http://127.0.0.1/console/knowledge?scope=shared'),userName:async()=> '合成授权人',deps:{packs:{},knowledge:{spaces:{visible:async()=>visible}}}} as unknown as PageContext;
 const body=String(await spaceLayout(ctx,html`正文`));
 assert.match(body,/合成授权人/);assert.match(body,/<details open>/);assert.match(body,/scope=shared/);assert.doesNotMatch(body,/private/);
 assert.match(body,/>allowed</);assert.match(body,/>child</);assert.doesNotMatch(body,/>\/allowed/);
 assert.match(body,/scope=shared" aria-current="page"/);
 assert.ok(body.indexOf('scope=all')<body.indexOf('scope=personal'));assert.ok(body.indexOf('scope=personal')<body.indexOf('scope=shared'));assert.ok(body.indexOf('scope=shared')<body.indexOf('scope=team'));
 visible[0].paths=['/ancestor/allowed'];visible[0].version.body.directories=['/','/ancestor','/ancestor/allowed','/ancestor/allowed/child'];
 const nested=String(await spaceLayout(ctx,html``));assert.match(nested,/>allowed</);assert.match(nested,/>child</);assert.doesNotMatch(nested,/>ancestor</);
 visible.length=0;ctx.url=new URL('http://127.0.0.1/console/knowledge');
 assert.doesNotMatch(String(await spaceLayout(ctx,html``)),/共享给我的/);
 assert.equal(inScope('personal','reader','reader'),true);assert.equal(inScope('shared','owner','reader'),true);assert.equal(inScope('team','owner','reader'),false);
});
test('unreadable product ancestors are absent and rendering requests no root initialization',async()=>{
 let initialized:unknown;
 const visible=[{space:'team',paths:['/'],version:{body:{directories:['/','/公共','/产品','/产品/hidden-line','/产品/hidden-line/1'],products:[{product:'hidden-line',line:'1',path:'/产品/hidden-line/1',root:'a'.repeat(64)}]}}}];
 const ctx={principal:{id:'reader'},url:new URL('http://127.0.0.1/console/knowledge?scope=team'),userName:async()=> '合成成员',deps:{knowledge:{spaces:{visible:async(_by:unknown,_scope:unknown,_onError:unknown,options:unknown)=>{initialized=options;return visible;}}},products:{products:async()=>[{product:{id:'hidden-line',title:'不可读取的产品'}}],readableProducts:async()=>new Set()}}} as unknown as PageContext;
 const body=String(await spaceLayout(ctx,html``));assert.deepEqual(initialized,{initialize:false});assert.doesNotMatch(body,/hidden-line|不可读取的产品|%E4%BA%A7%E5%93%81/);assert.match(body,/公共/);
 ctx.deps.products!.readableProducts=async()=>new Set(['hidden-line']);
 const readable=String(await spaceLayout(ctx,html``));assert.match(readable,/>产品</);assert.match(readable,/>不可读取的产品</);assert.match(readable,/>1</);
});
test('the memory panel derives directories from memory permissions without querying knowledge grants',async()=>{
 const items=[{space:'owner',path:'/偏好/排版'}];
 const ctx={principal:{id:'reader'},url:new URL('http://127.0.0.1/console/knowledge?scope=shared&view=memory'),userName:async()=> '合成记忆作者',deps:{knowledge:{spaces:{visible:async()=>{throw Error('knowledge must not authorize memory');}},memory:{items:async()=>items}}}} as unknown as PageContext;
 const body=String(await spaceLayout(ctx,html``));assert.match(body,/合成记忆作者/);assert.match(body,/>偏好</);assert.match(body,/>排版</);assert.doesNotMatch(body,/>\/偏好/);
 assert.match(String(knowledgeTabs(ctx)),/view=memory" class="on" aria-current="page"/);
 items.length=0;assert.doesNotMatch(String(await spaceLayout(ctx,html``)),/共享给我的/);
});
