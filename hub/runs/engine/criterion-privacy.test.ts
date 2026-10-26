import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
import {installReview,judgment,criterionRequests,revision} from './testing/criterion-review.ts';
import {callTool} from '../../server/tools.ts';
import {createDefaultRegistry} from '../../refs/api.ts';
import type {ServerDeps} from '../../server/api.ts';
async function get(h:Awaited<ReturnType<typeof criterionHarness>>,reference:string,principal=h.alice){const deps={records:h.kit,runs:h.service,knowledge:h.knowledge,parsers:createDefaultRegistry()} as unknown as ServerDeps;return callTool(deps,{principal,context:{traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:null,adminNote:()=>{}},state:{method:'tools/call',tool:'get_nodes',args:{},started:0,runId:null,callResult:null,acceptance:null,errorCode:null,notes:[]}},'get_nodes',{reference});}
test('authors see safe decision summaries but get_nodes cannot resolve the reviewer private result',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());await installReview(h);const draft=await h.start();await h.submit(draft.run,[h.proposal]);const request=(await criterionRequests(h,draft.run))[0],review=await judgment(h,draft.run,request);
 const denied=await get(h,'rec:'+review.record);assert.equal((denied.structuredContent as any).errors[0].code,'SOURCE_UNAVAILABLE');assert.match(denied.content[0].text,/对你不可用/);assert.ok(!JSON.stringify(denied).includes('合成复核理由'));const allowed=await get(h,'rec:'+review.record,h.admin);assert.equal((allowed.structuredContent as any).call_result,'ok');
 const answers=await h.kit.store.find<any>({kind:'action',key:'runs.request.answer',value:request.record,limit:1,newestFirst:true}),visible=await get(h,'rec:'+answers.items[0].digest);assert.equal((visible.structuredContent as any).call_result,'ok');assert.ok(JSON.stringify(visible).includes('合成复核理由'));
 const detail=await h.service.getRun(h.alice,draft.run);assert.equal(detail?.run.criterion_changes?.[0].reason,'合成复核理由');
 const next=await revision(h,draft.run),notice=next.criterion_changes![0];assert.equal(notice.accepted,true);assert.equal(notice.reviewer,h.admin.id);assert.equal(notice.reason,'合成复核理由');assert.equal(await h.service.getResult(h.alice,review.result.run),null);
});
