// One unit style for byte counts across the console, the exact count kept in the tooltip (issue 244).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {exactSize} from './knowledge-display.ts';

test('a byte count shows in the console unit style with its exact count in the tooltip, never as a bare number or a second unit word',()=>{
 assert.equal(String(exactSize(164)),'<span class="nowrap" title="164 字节">164 B</span>');
 assert.equal(String(exactSize(0)),'<span class="nowrap" title="0 字节">0 B</span>');
 // Larger counts keep the 1024-based units of the rest of the console and the exact count in the tooltip.
 assert.equal(String(exactSize(1536)),'<span class="nowrap" title="1,536 字节">1.5 KB</span>');
 assert.equal(String(exactSize(1048576)),'<span class="nowrap" title="1,048,576 字节">1.0 MB</span>');
 assert.ok(!String(exactSize(164)).includes('164 字节</span>'),'the visible text carries the unit style, not the long unit word');
});

test('an unreadable count says it is unknown, not a size',()=>{
 assert.match(String(exactSize(-1)),/>未知</);assert.match(String(exactSize(Number.NaN)),/>未知</);
});
