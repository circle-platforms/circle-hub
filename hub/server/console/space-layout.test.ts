import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spaceLayout,inScope,knowledgeTabs} from './space-layout.ts';
import {html,pageLayout,type Html} from './html.ts';
const render=(content:Html)=>content.text+(content.layout.sidebar?.text??'');
import type {PageContext} from './pages.ts';
test('the shared panel groups only current authorized paths and keeps displayed directories slash-free',async()=>{
 const visible=[{space:'owner',paths:['/allowed'],version:{body:{directories:['/','/allowed','/allowed/child','/private'],products:[],entries:[{path:'/allowed/child'},{path:'/private'}]}}}];
 const ctx={principal:{id:'reader'},url:new URL('http://127.0.0.1/console/knowledge?scope=shared'),userName:async()=> '合成授权人',deps:{packs:{},knowledge:{spaces:{visible:async()=>visible}}}} as unknown as PageContext;
 const layout=await spaceLayout(ctx,pageLayout(html`正文`,{detail:true,back:html`<a href="/console/knowledge?scope=shared">返回列表</a>`})),body=render(layout);
 assert.equal(layout.layout.detail,true);assert.match(layout.layout.back?.text??'',/scope=shared/);
 // Decision 151: the layout adds no summary pane; the count of a scope stands beside the scope in the navigation.
 assert.equal(layout.layout.inspector,null);
 assert.match(layout.layout.sidebar?.text??'',/与我共享 <span class="ch-count">1<\/span>/,'unreadable private rows do not contribute to the count of the scope');
 assert.match(body,/合成授权人/);assert.match(body,/<details open>/);assert.match(body,/scope=shared/);assert.doesNotMatch(body,/private/);
 assert.match(body,/>allowed</);assert.match(body,/>child</);assert.doesNotMatch(body,/>\/allowed/);
 assert.match(body,/scope=shared" aria-current="page"/);
 assert.match(body,/scope=shared" aria-current="page">与我共享 <span class="ch-count">1<\/span>/);
 assert.ok(body.indexOf('scope=all')<body.indexOf('scope=personal'));assert.ok(body.indexOf('scope=personal')<body.indexOf('scope=shared'));assert.ok(body.indexOf('scope=shared')<body.indexOf('scope=team'));
 visible[0].paths=['/ancestor/allowed'];visible[0].version.body.directories=['/','/ancestor','/ancestor/allowed','/ancestor/allowed/child'];
 const nested=render(await spaceLayout(ctx,html``));assert.match(nested,/>allowed</);assert.match(nested,/>child</);assert.doesNotMatch(nested,/>ancestor</);
 visible.length=0;ctx.url=new URL('http://127.0.0.1/console/knowledge');
 assert.doesNotMatch(render(await spaceLayout(ctx,html``)),/与我共享/);
 assert.equal(inScope('personal','reader','reader'),true);assert.equal(inScope('shared','owner','reader'),true);assert.equal(inScope('team','owner','reader'),false);
});
test('unreadable product ancestors are absent and rendering requests no root initialization',async()=>{
 let initialized:unknown;
 const visible=[{space:'team',paths:['/'],version:{body:{directories:['/','/公共','/产品','/产品/hidden-line','/产品/hidden-line/1'],products:[{product:'hidden-line',line:'1',path:'/产品/hidden-line/1',root:'a'.repeat(64)}],entries:[]}}}];
 const ctx={principal:{id:'reader'},url:new URL('http://127.0.0.1/console/knowledge?scope=team'),userName:async()=> '合成成员',deps:{knowledge:{spaces:{visible:async(_by:unknown,_scope:unknown,_onError:unknown,options:unknown)=>{initialized=options;return visible;}}},products:{products:async()=>[{product:{id:'hidden-line',title:'不可读取的产品'}}],readableProducts:async()=>new Set()}}} as unknown as PageContext;
 const body=render(await spaceLayout(ctx,html``));assert.deepEqual(initialized,{initialize:false});assert.doesNotMatch(body,/hidden-line|不可读取的产品|%E4%BA%A7%E5%93%81/);assert.match(body,/公共/);
 ctx.deps.products!.readableProducts=async()=>new Set(['hidden-line']);
 const readable=render(await spaceLayout(ctx,html``));assert.match(readable,/>产品</);assert.match(readable,/>不可读取的产品</);assert.match(readable,/>1</);
});
test('the memory panel derives directories from memory permissions without querying knowledge grants',async()=>{
 const items=[{space:'owner',path:'/偏好/排版'}];
 const ctx={principal:{id:'reader'},url:new URL('http://127.0.0.1/console/knowledge?scope=shared&view=memory'),userName:async()=> '合成记忆作者',deps:{knowledge:{spaces:{visible:async()=>{throw Error('knowledge must not authorize memory');}},memory:{items:async()=>items}}}} as unknown as PageContext;
 const body=render(await spaceLayout(ctx,html``));assert.match(body,/合成记忆作者/);assert.match(body,/>偏好</);assert.match(body,/>排版</);assert.doesNotMatch(body,/>\/偏好/);
 assert.match(String(knowledgeTabs(ctx)),/view=memory" aria-current="page"/);
 const own=render(await spaceLayout({...ctx,principal:{...ctx.principal,id:'owner'},url:new URL('http://127.0.0.1/console/knowledge?scope=personal&view=memory')},html``));assert.doesNotMatch(own,/<summary>个人<\/summary>/);
 items.length=0;assert.doesNotMatch(render(await spaceLayout(ctx,html``)),/与我共享/);
});
