import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {MODEL_VERSION,PROTOCOL_CODES} from '../generated/protocol.ts';
const model=JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));

test('model 44: source content is not scanned for credentials, held, refused or sent for review (decision 154)',()=>{
 assert.ok(model.version>=44);assert.equal(MODEL_VERSION,model.version);
 const b02=model.elements.find((e:{id:string})=>e.id==='B02'),rule:string=b02.rules[4];
 assert.ok(rule.includes('不做凭据扫描')&&rule.includes('只保留、拒收或送管理员核看'),'the rule says what no longer happens to content');
 assert.ok(rule.includes('决定 154')&&rule.includes('issue #194'));
 assert.ok(rule.includes('credential-scan@3')&&rule.includes('不改写'),'records stored under the detectors are not rewritten and keep their rules');
 assert.ok(rule.includes('R[6]'),'an echo of a credential the Hub itself sent is still its own case');
 assert.ok(b02.rules[6].startsWith('Hub 实际发出的密钥或可复用派生凭据被应答回显时'),'and that case is unchanged');
 assert.equal(b02.changes44.length,1);
 // The codes of the old refusals stay registered: records and receipts stored before carry them.
 for(const code of ['CREDENTIAL_IN_UPLOAD','SOURCE_PENDING_REVIEW','MEMORY_CREDENTIALS_DETECTED','SPACE_CREDENTIALS_DETECTED'])assert.ok(code in PROTOCOL_CODES,code);
});
