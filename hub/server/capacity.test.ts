import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatCapacity,exactBytes,parseCapacity,capacityInput} from './capacity.ts';
test('capacity uses one decimal and exact byte evidence independently of the input unit',()=>{
 assert.equal(formatCapacity(99793),'97.5 KB');assert.equal(formatCapacity(1073741824),'1.0 GB');assert.equal(formatCapacity(0),'0.0 KB');assert.equal(exactBytes(1073741824),'1,073,741,824 字节');assert.equal(formatCapacity(1024**2*1234),'1.2 GB');
 for(const bytes of [0,1,99793,1048576,1073741824,Number.MAX_SAFE_INTEGER]){const input=capacityInput(bytes);assert.equal(parseCapacity(input.amount,input.unit),bytes,'input must not reuse a rounded display');}
});
test('unit conversion admits exact integer bytes and rejects fractions, unknown units, signs and overflow',()=>{
 assert.equal(parseCapacity('0.5','mb'),524288);assert.equal(parseCapacity('1.5','gb'),1610612736);assert.equal(parseCapacity('0','gb'),0);assert.equal(parseCapacity('0.00000095367431640625','mb'),1);
 for(const [amount,unit]of [['-1','mb'],['0.1','mb'],['0.000000001','gb'],['1','kb'],['1','GB'],['9007199254740991','gb'],['1e3','mb'],['NaN','mb'],['Infinity','gb'],['','gb'],['9'.repeat(100),'mb']])assert.throws(()=>parseCapacity(amount,unit),TypeError);
});
