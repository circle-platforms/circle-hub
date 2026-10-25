// The root report and the board read exactly the same synthetic content, but count different missing facts.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {labelOf} from '../../../../contracts/generated/vocabulary.ts';
import {countWorld} from '../../../../hub/knowledge/counts-test-support.ts';
import {startPostgres,type TemporaryPostgres} from '../../../../hub/testing/postgres.ts';
import {callPackFunction} from '../../../../hub/rules/api.ts';
import {sha256Hex} from '../../../../hub/records/api.ts';
let postgres:TemporaryPostgres;before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('position counts match report summaries while the board counts commandless cases without changing its rule',async t=>{
 const w=await countWorld(postgres,{commandlessOverlap:true});t.after(()=>w.close());
 const report=await w.knowledge.syncProduct(w.product);const build=report.builds[0];assert.equal(build.outcome,'produced',build.reason);
 const at={build:build.name,root:build.root!,composition:build.composition!};
 // 看板现在要求 test_type_status。这份合成根没有该字段，读出来是 null；用例的 negative 是布尔，按已声明补上，否则视图会被拒。
 const counts=await w.knowledge.views.facets(w.product.id,at,'case',['line','module','has_expected','negative','test_type_status'],new Set(), null, undefined, null);
 for(const row of counts.rows){if(row.values.test_type_status===null&&typeof row.values.negative==='boolean')row.values.test_type_status='declared';}
 const commands=await w.knowledge.views.facets(w.product.id,at,'case',['commands'],new Set(), null, undefined, null);
 assert.deepEqual(commands.totals.entry_counts,build.entry_counts);
 assert.equal(commands.totals.entry_counts?.unplaced,3);
 assert.equal(commands.totals.empty.commands,4,'the placed overlap still has no command; the board business rule stays unchanged');
 const bound=(slot:string,model:unknown)=>({slot,model,sha256:sha256Hex(JSON.stringify(model))});
 const packDir=fileURLToPath(new URL('..',import.meta.url));
 const projected=(await callPackFunction({packDir,module:'functions/project.ts'},{inputs:[bound('facets',counts),bound('placement',commands)],context:{product:w.product.id}}, {},{requireOsIsolation:false})).output as any;
 assert.ok(projected.items?.length,JSON.stringify(projected));assert.equal(projected.groups[0].placement.unplaced,4);
 const outcome=(await callPackFunction({packDir,module:'functions/totals.ts',export:'totalsOutcome'},{items:projected.items,context:{groups:projected.groups}}, {},{requireOsIsolation:false})).output as any;
 assert.equal(outcome.verdict,'support');assert.ok(outcome.statement.includes(labelOf('knowledge_count','commandless_cases')));
 assert.ok(!outcome.statement.includes(labelOf('knowledge_count','tree_unplaced_entries')));
});
