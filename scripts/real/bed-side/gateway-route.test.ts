import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const component=dirname(fileURLToPath(import.meta.url));
const program=String.raw`
import json,sys,types
sys.path.insert(0,sys.argv[1])
from cell_gateway import Gateway,Framework
mode=json.load(sys.stdin)['mode'];rows=[];calls=[]
class Original:
 def audit(self,event,**fields):
  if mode=='audit_failure':return False
  rows.append({'event':event,**fields});return True
 def call(self,caller,name,args):calls.append(('original',name));return {'legacy':name}
class Private:
 def call(self,caller,name,args):
  calls.append(('private',name))
  if mode=='replay':return {'ok':False,'replayed':True,'task_id':'existing-task'}
  return {'ok':True,'task_id':'new-task'}
original=Original();router=Gateway(original,Private());caller=types.SimpleNamespace(subject='synthetic')
if mode=='stage_failure':
 def denied(*args,**kwargs):return False
 class Frame:
  def stage_case(self,*args):calls.append('must-not-stage')
 try:Framework(Frame(),'synthetic-contract',denied).stage_case(None,'module','case',b'workbook','digest','new-task')
 except ValueError as error:answer={'error':str(error)}
else:
 answer=router.call(caller,'case_submit_cell',{'xlsx_b64':'SYNTHETIC_NOT_FOR_AUDIT'})
 legacy=router.call(caller,'case_status',{})
print(json.dumps({'answer':answer,'rows':rows,'calls':calls}))
`;
function run(mode:string){
 const p=spawnSync('python3',['-B','-c',program,component],{input:JSON.stringify({mode}),encoding:'utf8',env:{PATH:process.env.PATH??'',PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
test('cell route audit correlates the actual returned task without logging workbook arguments or changing old calls',()=>{
 const r=run('success');assert.deepEqual(r.answer,{ok:true,task_id:'new-task'});
 assert.deepEqual(r.calls,[['private','case_submit'],['original','case_status']]);
 assert.equal(r.rows[0].event,'cell_route_requested');assert.equal(r.rows[0].tool,'case_submit_cell');
 assert.deepEqual(r.rows[1],{event:'cell_route_result',tool:'case_submit_cell',subject:'synthetic',task_id:'new-task',response_ok:true,replayed:null});
 assert.ok(!JSON.stringify(r.rows).includes('SYNTHETIC_NOT_FOR_AUDIT'));
});
test('replayed cell submissions retain the original response and never claim a newly staged task',()=>{
 const r=run('replay');assert.deepEqual(r.answer,{ok:false,replayed:true,task_id:'existing-task'});
 assert.equal(r.rows[1].task_id,'existing-task');assert.equal(r.rows[1].replayed,true);assert.equal(r.rows[1].response_ok,false);
 assert.ok(r.rows.every((row:{event:string})=>row.event!=='cell_route_task'));
});
test('an unpersisted route audit refuses the new submission while original tools remain callable',()=>{
 const r=run('audit_failure');assert.equal(r.answer.ok,false);assert.equal(r.answer.reached_device,false);
 assert.deepEqual(r.calls,[['original','case_status']]);assert.deepEqual(r.rows,[]);
});
test('an unpersisted allocated-task route audit prevents staging and runner launch',()=>{
 const r=run('stage_failure');assert.match(r.answer.error,/任务路线审计未能保存/);assert.deepEqual(r.calls,[]);
});
