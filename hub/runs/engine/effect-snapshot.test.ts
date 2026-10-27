import {createTestParserRegistry} from '../../testing/parsers.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness,sandboxSkip} from './testing/harness.ts';
import {toyMap,standardDocument} from './testing/mindmap.ts';
import {createRunsService} from './api.ts';
const skip=await sandboxSkip();
test('start_run freezes effect metadata through the internal port without listing as the runner',{skip},async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await openHarness(pg);t.after(()=>h.close());
 const variables=await h.kit.variables.snapshot();let captured:unknown;
 const service=createRunsService({parsers:createTestParserRegistry(),records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external,sandbox:{requireOsIsolation:false},effectRegistry:{snapshot:async value=>{captured=value;return {policy:'a'.repeat(64),executors:'b'.repeat(64)};}}});
 const map=await h.upload(h.alice,toyMap(standardDocument()));const answer=await service.startRun(h.alice,{pack:'toy-review',product:'Meadow',inputs:{map:{reference:map}}},h.call());
 assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));const detail=await service.getRun(h.alice,answer.run!.run);assert.equal(detail!.run.policy,'a'.repeat(64));assert.equal(detail!.run.executors,'b'.repeat(64));assert.deepEqual(captured,variables);
});
