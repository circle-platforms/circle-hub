import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quotedFromCase} from './lines.ts';
test('R4 command reference requires a complete original source line with exact characters',()=>{
 const lines=['demo status','demo set 192.0.2.7','执行 demo status 查看','Box#demo status','demo status.'];
 assert.equal(quotedFromCase('demo status',lines),true);
 for(const value of ['DEMO status','ｄｅｍｏ status','demo  status','demo set 192.0.2','demo set'])assert.equal(quotedFromCase(value,lines),false,value);
 assert.equal(quotedFromCase('demo status',['执行 demo status 查看','Box#demo status','demo status.']),false,'no prose, prompt or punctuation guessing');
});
