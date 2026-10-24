import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AXES,labelOf} from '../generated/vocabulary.ts';
test('tree position and command ownership counts have distinct generated labels',()=>{
 assert.equal(AXES.knowledge_count.owner,'K05');
 assert.equal(labelOf('knowledge_count','tree_unplaced_entries'),'未挂到树上位置的条目');
 assert.equal(labelOf('knowledge_count','commandless_cases'),'未归位（没有命令归属的用例）');
});

test('count summaries reject contradictory arithmetic while legacy views remain readable', async () => {
 const { KnowledgeEntryCounts, FacetView } = await import('./views.ts');
 assert.equal(KnowledgeEntryCounts.safeParse({ total: 5, placed: 2, unplaced: 3 }).success, true);
 assert.equal(KnowledgeEntryCounts.safeParse({ total: 2, placed: 2, unplaced: 3 }).success, false);
 const legacy = { schema: 'facet-view@1', product: 'demo', build: { build: 'Rel_DEMO_10_6_1_1', root: 'a'.repeat(64) }, kind: 'case', by: ['commands'], rows: [], total: 5, totals: { empty: { commands: 4 } }, truncated: true, skipped: 0, notes: [] };
 assert.equal(FacetView.safeParse(legacy).success, true);
 assert.equal(FacetView.safeParse({ ...legacy, totals: { ...legacy.totals, entry_counts: { total: 4, placed: 1, unplaced: 3 } } }).success, false);
 assert.equal(FacetView.safeParse({ ...legacy, totals: { ...legacy.totals, entry_counts: { total: 5, placed: 2, unplaced: 3 } } }).success, true);
});
