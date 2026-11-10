// What the sharing dialog says a setting decides and what revoking one leaves (issue 235). A minimal page context, no server.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {html} from './html.ts';
import {grantDialog} from './grant-dialog.ts';
import {wordingProblems} from './testing-wording.ts';
import type {PageContext} from './pages.ts';

const MEMBER='usr_synthetic_reader',GRANT={audience:'member',member:MEMBER,at:'2026-11-10T01:00:00.000Z',path:'/合成目录'};
const key=JSON.stringify([GRANT.audience,GRANT.member,GRANT.path]);
const context=(selection?:string)=>({
 url:new URL('http://127.0.0.1/console/knowledge/space'+(selection===undefined?'':'?share_selection='+encodeURIComponent(selection))),
 deps:{records:{principals:{list:async()=>[{id:'usr_synthetic_admin',role:'admin',disabled:false}]}}},
 userName:async(id:string)=>id==='usr_synthetic_reader'?'合成读者':id,
}) as unknown as PageContext;
const open=async(selection?:string)=>String(await grantDialog(context(selection),{id:'grants-synthetic',content:'合成条目',current:'仅本人',checks:[],grants:[GRANT],form:(action,fields,label)=>html`<form data-action="${action}">${fields}<button>${label}</button></form>`,fields:html``}));

test('the sharing dialog says what a setting decides and what it leaves alone, without set-theory wording',async()=>{
 const shown=await open();
 assert.match(shown,/一项内容可以有多项分享设置，收回其中一项后，仍可能通过其他有效的分享读取/);
 assert.match(shown,/分享只决定谁能读取，不会创建或删除已分享到团队的独立副本/);
 assert.match(shown,/工作流的使用权限与它产生的结果的分享范围分别设置/);
 assert.doesNotMatch(shown,/取并集|分别判定/);
 assert.deepEqual(wordingProblems(shown),[]);
});

test('revoking one setting says it may still be readable through another and that what was read cannot be taken back',async()=>{
 assert.ok(!(await open()).includes('收回这项分享后'),'no revoke text until a setting is chosen');
 const shown=await open(key);
 assert.match(shown,/收回这项分享后，不能再通过它读取；仍可能通过其他有效的分享读取。已读或已引用的内容无法追回。/);
 assert.doesNotMatch(shown,/收回后不能继续读取/);
 assert.deepEqual(wordingProblems(shown),[]);
});
