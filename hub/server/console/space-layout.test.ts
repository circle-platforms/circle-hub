import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spaceLayout,inScope} from './space-layout.ts';
import {html} from './html.ts';
import type {PageContext} from './pages.ts';
test('the shared panel groups only current authorized paths and keeps displayed directories slash-free',async()=>{
 const visible=[{space:'owner',paths:['/allowed'],version:{body:{directories:['/','/allowed','/allowed/child','/private'],products:[]}}}];
 const ctx={principal:{id:'reader'},url:new URL('http://127.0.0.1/console/knowledge?scope=shared'),userName:async()=> '合成授权人',deps:{packs:{},knowledge:{spaces:{visible:async()=>visible}}}} as unknown as PageContext;
 const body=String(await spaceLayout(ctx,html`正文`));
 assert.match(body,/合成授权人/);assert.match(body,/<details open>/);assert.match(body,/scope=shared/);assert.doesNotMatch(body,/private/);
 assert.match(body,/>allowed</);assert.match(body,/>child</);assert.doesNotMatch(body,/>\/allowed/);
 visible.length=0;ctx.url=new URL('http://127.0.0.1/console/knowledge');
 assert.doesNotMatch(String(await spaceLayout(ctx,html``)),/共享给我的/);
 assert.equal(inScope('personal','reader','reader'),true);assert.equal(inScope('shared','owner','reader'),true);assert.equal(inScope('team','owner','reader'),false);
});
