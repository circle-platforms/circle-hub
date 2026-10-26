import {osIsolationAvailable} from '../../rules/api.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openHarness} from './testing/harness.ts';
import {writePack,type PackSpec} from './testing/packs.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {createKnowledge} from '../../knowledge/api.ts';
import {createDefaultRegistry} from '../../refs/api.ts';
import {runContextOf} from './evaluate.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
test('start freezes feeding before bound and expected source reads; checks and result locks retain the same horizon',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await openHarness(pg);t.after(()=>h.close());const dir=await mkdtemp(join(tmpdir(),'hub-feeding-engine-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const knowledge=createKnowledge({sandbox:{requireOsIsolation:await osIsolationAvailable()},records:h.kit,packs:h.packs,external:h.external,parsers:createDefaultRegistry(),admin:h.admin});Object.assign(h.knowledge,{feeding:knowledge.feeding});
 const spec:PackSpec={id:'synthetic-feeding',version:'1.0.0',kind:'workflow',title:'Synthetic feeding probe',description:'Synthetic source reads at 192.0.2.8',files:{
  'workflow.json':{json:{schema:'workflow@1',inputs:[{slot:'subject',role:'subject',description:'synthetic JSON',accepts:['application/json'],required:true,many:false}],parameters:[],product:{catalogs:[]},subject:'subject',projection:{module:'functions/project.ts'},expected_sources:{module:'functions/expected.ts'}}},
  'requirements.json':{json:{schema:'requirements@1',requirements:[{key:'probe',name:'Synthetic probe',description:'Echo horizon',target:'run',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['probe'],error_handling:[]}]}},
  'checks.json':{json:{schema:'checks@1',checks:[{id:'probe',applies:'run',judges:'subject',reads:{roles:['expected']},tier:'advisory',function:{module:'functions/check.ts'},subject:{module:'functions/subject.ts'}}]}},
  'slots.schema.json':{json:{schema:'slots@1',item:{},run:{}}},
  'SKILL.md':'Read synthetic sources and return a complete feeding inventory',
  'functions/project.ts':`export default input=>({items:[{id:'one',label:'Synthetic',location:{slot:'subject',parser:'json@1',selector:'p'},fields:{}}],warnings:[]});`,
  'functions/expected.ts':`export default input=>({sources:[{external:'toy:story:4021',role:'expected',reason:'Synthetic guide'}],warnings:[]});`,
  'functions/subject.ts':`export default input=>({context:input.context});`,
  'functions/check.ts':`export default input=>[{verdict:'support',statement:'Scripted probe',grounds:[],tier:'advisory',data:{feeding_offset:input.subject.context.feeding_offset,read_count:Object.keys(input.record??{}).length}}];`,
 }};
 await h.workflows.add(await writePack(dir,spec));h.workflows.assign(h.alice.id,spec.id);const uploaded=await h.upload(h.alice,Buffer.from('{"line":"10.8","platform":"zx-u"}'),'application/json');const started=await h.service.startRunDetailed(h.alice,{pack:spec.id,inputs:{subject:{reference:uploaded}}},h.call());assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer));const id=started.answer.run!.run;const detail=await h.service.getRun(h.alice,id);assert.ok(detail);const run=RunRecord.parse(detail.run);assert.ok(run.feeding_offset);assert.equal(run.feeding_offset.root,null);assert.deepEqual(runContextOf(run).feeding_offset,run.feeding_offset);const uses=await knowledge.feeding!.usages(h.alice,id);assert.ok(uses.includes(uploaded.slice(4)));const expected=run.sources.find(source=>source.role==='expected');assert.ok(expected);assert.ok(uses.includes(expected.reference.slice(4)));const frozen=run.feeding_offset.offset;assert.ok(await knowledge.feeding!.offset()>frozen);assert.equal((await knowledge.feeding!.freeze(h.alice,id,null)).offset,frozen);
 assert.ok(started.production);assert.deepEqual(started.production.result.locks.feeding_offset,run.feeding_offset);const probe=started.production.result.cross_item.find(claim=>claim.requirement==='probe');assert.ok(probe);assert.deepEqual(probe.statement.data?.feeding_offset,run.feeding_offset);
});
