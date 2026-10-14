import assert from 'node:assert/strict';
import {test} from 'node:test';
import {zipSync} from 'fflate';
import {boundedUnzip} from '../../packages/knowledge/src/zip.ts';
test('Archive expansion is bounded by actual bytes even when zip headers lie',()=>{
  const raw=Buffer.alloc(2*1024*1024,65),zip=Buffer.from(zipSync({'content.txt':raw}));
  for(let offset=0;offset<zip.length-4;offset++){const marker=zip.readUInt32LE(offset);if(marker===0x04034b50)zip.writeUInt32LE(1,offset+22);if(marker===0x02014b50)zip.writeUInt32LE(1,offset+24);}
  assert.throws(()=>boundedUnzip(zip,{maxBytes:1024*1024}),/expanded|expansion/i);
  const valid=Buffer.from(zipSync({'folder/content.txt':Buffer.from('synthetic')}));assert.equal(Buffer.from(boundedUnzip(valid)['folder/content.txt']).toString(),'synthetic');
});
