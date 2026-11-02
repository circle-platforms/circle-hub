import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {auditContrast,contrast,composite} from './contrast.ts';
import {CSS} from './style.ts';
import {DESIGN_CSS} from './style.generated.ts';

test('both token themes pass text, control, selected-row, badge and chart contrast on their actual surfaces',()=>{
 assert.equal(contrast([0,0,0,1],[1,1,1,1]),21);assert.deepEqual(composite([1,1,1,.5],[0,0,0,1]),[.5,.5,.5,1]);
 const samples=auditContrast(JSON.parse(readFileSync(new URL('../../../docs/design/circle-design-system/tokens.json',import.meta.url),'utf8')));
 const failures=samples.filter(row=>row.ratio<row.required);assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 assert.ok(samples.length>250);assert.match(DESIGN_CSS,/PR #135/);assert.match(DESIGN_CSS,/\.ch-row-meta[\s\S]+color:var\(--text-secondary\)/);assert.match(DESIGN_CSS,/aria-pressed="true"[\s\S]+var\(--focus-ring\)/);assert.match(CSS,/\.ch-chart\.is-dim \.bar:not\(\.is-hot\)\{opacity:\.9\}/);
 // Decorative hairlines, chart grids, brand marks and disabled controls do not establish a passing sample.
 assert.ok(!samples.some(row=>/hairline|chart-grid|disabled|brand-/.test(row.role)));
});
