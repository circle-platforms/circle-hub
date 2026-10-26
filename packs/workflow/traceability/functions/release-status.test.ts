import {readIndexView} from './views.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildMatrix} from './matrix.ts';
import {traceOutcomes} from './check.ts';
import {defectEntry,caseEntry,indexViewOf,boundView} from './test-support.ts';
import {projectItems} from './project.ts';
import {countsOutcome} from './counts.ts';
const H='a'.repeat(64);
function fixture(anonymous=false){const defect=defectEntry({bug:'SYN-1'});defect.data={...defect.data,status:null,declaration_status:'undeclared',missing:'缺原始 status',next_action:'来源维护者补原件后重产',...(anonymous?{bug:null,identity_declaration_status:'undeclared'}:{})};const dv=indexViewOf('defect','bug',[defect]),cv=indexViewOf('case','defects',[caseEntry({defects:['SYN-1'],case:'C-1'})]);return {defect,dv,cv};}
test('status filtering cannot silently discard an undeclared defect even with an indexed case',()=>{
 const {dv,cv}=fixture();const out=projectItems({inputs:[boundView('defects',dv),boundView('cases',cv)],parameters:{statuses:['fixed']}});assert.ok(!('error'in out),JSON.stringify(out));const item=out.items[0];assert.equal(item.fields.declaration_status,'undeclared');assert.equal((item.fields.cases as unknown[]).length,1);const subject={items:out.items,context:{groups:out.groups}};const results=traceOutcomes(subject);assert.equal(results[0].verdict,'unknown');assert.equal(results[0].reason,'missing_input');assert.ok(results[0].missing);assert.match(results[0].statement,/下一步/);assert.equal(results[0].data?.status,null);assert.equal(countsOutcome(subject).data?.release_status_undeclared,1);
});
test('an unidentified release gap gets its own pending item, never a fabricated bug id',()=>{const {dv,cv}=fixture(true);const out=projectItems({inputs:[boundView('defects',dv),boundView('cases',cv)],parameters:{}});assert.ok(!('error'in out),JSON.stringify(out));assert.equal(out.items[0].fields.bug,'');assert.match(out.items[0].id,/^undeclared:/);assert.equal(traceOutcomes({items:out.items,context:{groups:out.groups}})[0].verdict,'unknown');});
test('historical fixed labels without author declaration cannot prove a fixed status in a new run',()=>{const defect=defectEntry({bug:'SYN-1'});delete defect.data.declaration_status;const dv=readIndexView(boundView('defects',indexViewOf('defect','bug',[defect])),'defects',{kind:'defect',key:'bug'}),cv=readIndexView(boundView('cases',indexViewOf('case','defects',[])),'cases',{kind:'case',key:'defects'});assert.ok(dv.ok&&cv.ok);if(!dv.ok||!cv.ok)return;const rows=buildMatrix(dv.view,cv.view,['fixed']);assert.equal(rows[0].declaration_status,'undeclared');assert.deepEqual(rows[0].statuses,[]);});
