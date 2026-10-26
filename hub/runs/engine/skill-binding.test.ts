// Verified parser scope can add an explicitly declared legacy parser lock without rewriting the original run.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {createTestParserRegistry} from '../../testing/parsers.ts';
import {openHarness} from './testing/harness.ts';
import {standardDocument,toyMap} from './testing/mindmap.ts';
import {createRunsService} from './service.ts';
import {createEngineContext} from './deps.ts';
import {evaluate,productionEvaluationInput} from './evaluate.ts';
test('reverification includes appended skill locks and their declaration while preserving original locks',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await openHarness(pg);t.after(()=>h.close());
 const deps={records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external,sandbox:{requireOsIsolation:false}};
 const service=createRunsService({...deps,parsers:createTestParserRegistry()});
 const started=await service.startRun(h.alice,{pack:'toy-locate',inputs:{map:{reference:await h.upload(h.alice,toyMap(standardDocument()))}}},h.call());assert.equal(started.call_result,'ok',JSON.stringify(started));
 const stored=(await service.getRun(h.alice,started.run!.run))!.run;
 const original={pack:'synthetic-original',version:'1.0.0',digest:'a'.repeat(64)},appended={pack:'synthetic-parser',version:'1.0.0',digest:'b'.repeat(64)},declaration='c'.repeat(64);
 const run={...stored,skills:[original]},parsers=createTestParserRegistry();parsers.skills=[original,appended];parsers.bindingRecords=[declaration];parsers.bindingDisclosure='迁移时点事后声明；合成测试';
 const result=(await evaluate(createEngineContext({...deps,parsers}),productionEvaluationInput(run,h.locate,'d'.repeat(64),h.call().traceId))).result;
 assert.deepEqual(result.locks.skills,[original,appended]);assert.deepEqual(run.skills,[original]);assert.ok(result.coverage.note?.includes('迁移时点事后声明'));
 const claims=Object.values(result.partitions).flatMap(items=>items.flatMap(item=>item.requirements.flatMap(requirement=>requirement.claims)));
 assert.ok(claims.length>0);assert.ok(claims.every(claim=>[original.digest,appended.digest,declaration].every(digest=>claim.validity.bound.includes(digest))));
});
