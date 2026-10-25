import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutorDefinition} from './definition.ts';
import {definition} from './testing/definition.ts';
import {reportPending,reportReadDelay,REPORT_READ_ATTEMPTS} from './report-read.ts';
const d=ExecutorDefinition.parse(definition('http://127.0.0.1:1'));
test('only declared report readiness and absent result fields cause semantic polling',()=>{
 assert.equal(reportPending({complete:false,rows:[]},d,['synthetic-case']),true);
 assert.equal(reportPending({complete:true,rows:[{id:'synthetic-case'}]},d,['synthetic-case']),true);
 assert.equal(reportPending({complete:true,rows:[{id:'synthetic-case',outcome:'good'}]},d,['synthetic-case']),false);
 assert.equal(reportPending({complete:true,rows:[{id:'synthetic-case',outcome:'undeclared'}]},d,['synthetic-case']),false);
 assert.equal(reportPending({complete:true,rows:[{id:'synthetic-case',outcome:'good'},{id:'synthetic-case',outcome:'good'}]},d,['synthetic-case']),false);
});
test('report backoff is capped and attempt counts do not depend on wall clock progress',()=>{
 const delays=Array.from({length:REPORT_READ_ATTEMPTS-1},(_,index)=>reportReadDelay(20,index+1));assert.deepEqual(delays,[20,40,80,160,320,640,1280]);assert.equal(reportReadDelay(30000,100),4000);
});
