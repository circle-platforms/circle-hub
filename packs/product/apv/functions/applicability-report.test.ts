import assert from 'node:assert/strict';
import {test} from 'node:test';
import {produceManualEntries} from './manual.ts';
import {markdown,fixtureBytes} from '../testing/test-support.ts';
import {APPLICABILITY_FIELD,labelOf} from './generated/vocabulary.ts';

test('production report counts direct and inherited entries by field, preserving override and conflict locations',()=>{
 const source='# Outer 装有 Card-A 时\n\n内存至少8GB。\n\n## Inner\n\n装有 Card-B 时。\n\n普通正文。\n\n## Conflict 需要 Permit-A 许可\n\n需要 Permit-B 许可。\n\n后续正文。\n';
 const out=produceManualEntries(markdown(source),null,{components:['Card-A','Card-B'],licenses:['Permit-A','Permit-B']});
 const report=out.applicability_report!;
 assert.deepEqual(report.counts.components,{direct:1,inherited:4});
 assert.deepEqual(report.counts.memory,{direct:1,inherited:4});
 assert.deepEqual(report.counts.licenses,{direct:0,inherited:0});
 assert.equal(report.overrides.length,1);assert.equal(report.conflicts.length,1);
 for(const field of APPLICABILITY_FIELD){const count=report.counts[field];assert.ok(out.warnings.includes(`适用条件统计：${labelOf('applicability_field',field)}：直接抽取 ${count.direct} 条，继承 ${count.inherited} 条`));}
 assert.ok(out.warnings.some(row=>row.includes('内外层不同')&&row.includes('Card-A')&&row.includes('Card-B')&&row.includes('l/1')));
 assert.ok(out.warnings.some(row=>row.includes('同章冲突')&&row.includes('Permit-A')&&row.includes('Permit-B')&&row.includes('下一步')));
});
test('the synthetic manual fixture exercises all four fields and counts actual entries',()=>{
 const out=produceManualEntries(markdown(fixtureBytes('manual.md')),null,{components:['Card-A'],licenses:['Permit-A'],deployment_forms:['Form-A']});
 for(const field of ['components','memory','licenses','deployment_forms'] as const){assert.ok(out.applicability_report!.counts[field].direct>0);assert.ok(out.applicability_report!.counts[field].inherited>0);}
});
