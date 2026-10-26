// This is a functional fixture, not proof of operating-system isolation. The production default remains fail-closed.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {toyMap,standardDocument} from './testing/mindmap.ts';

test('the synthetic functional harness can exercise projection with explicitly unavailable OS isolation',async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());
 const h=await openHarness(postgres,{sandbox:{requireOsIsolation:false}});t.after(()=>h.close());
 const reference=await h.upload(h.alice,toyMap(standardDocument()));
 const result=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',inputs:{map:{reference}}},h.call());
 assert.equal(result.call_result,'ok',JSON.stringify(result.errors));
 assert.equal(result.run!.items.length,4);
 assert.ok(h.external.reads.every(read=>read.id.startsWith('toy:')),'only closed synthetic sources are used');
});
