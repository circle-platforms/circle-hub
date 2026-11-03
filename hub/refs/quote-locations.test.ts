import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quoteLocations} from './api.ts';
test('exact quotation pages count every overlapping occurrence without changing whitespace or UTF-8 identity',()=>{
 assert.deepEqual(quoteLocations('合成😀\r\n甲甲甲','甲甲'),{total:2,matches:[{ordinal:0,from:12,to:18,line:2},{ordinal:1,from:15,to:21,line:2}]});
 assert.equal(quoteLocations('Ａ e\u0301\r\n','A').total,0);assert.equal(quoteLocations('e\u0301','é').total,0);assert.equal(quoteLocations('甲\r\n乙','甲\n乙').total,0);assert.equal(quoteLocations('甲',' ').total,0);
 const page=quoteLocations('甲'.repeat(10000),'甲',9998,1);assert.equal(page.total,10000);assert.deepEqual(page.matches,[{ordinal:9998,from:29994,to:29997,line:1}]);
 for(const n of [-1,0.5,Infinity])assert.throws(()=>quoteLocations('甲','甲',n),TypeError);
});
