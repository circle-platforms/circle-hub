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

test('model 47: the masking dictionary replaces what its rules match in a business system\'s text answer, and only there (decision 159)',()=>{
 assert.ok(model.version>=47);assert.equal(MODEL_VERSION,model.version);
 const b02=model.elements.find((e:{id:string})=>e.id==='B02'),rule:string=b02.rules[11];
 assert.ok(rule.startsWith('遮盖字典：管理员配置的一组规则'));
 // What is replaced, by what, and what is kept.
 for(const part of ['Hub 经连接器读业务系统时','[标签已遮盖 *****]','名为 secret 的分组','只保存替换后的字节','被替换的值 Hub 不保存','“原样保存”的唯一例外','没有命中的应答原样保存'])assert.ok(rule.includes(part),part);
 // What is left alone: other bytes and every content whose digest the client checks too.
 for(const part of ['二进制内容不替换','登录应答不替换','成员上传、写进知识空间和记忆的文字、客户端同步的内容、运行参数和派发内容不替换'])assert.ok(rule.includes(part),part);
 // A rule changes later reads only, and an echo of the Hub's own credential keeps its rule.
 for(const part of ['已保存的记录不改写','删除规则不恢复已替换的内容','仍按 R[6]','决定 159','issue #194'])assert.ok(rule.includes(part),part);
 assert.ok(b02.fields[6].startsWith('遮盖：只在业务系统的应答被遮盖字典替换过时有'));
 assert.ok(b02.rules[4].includes('遮盖字典见 R[11]')&&!b02.rules[4].includes('尚未实施'));
 assert.equal(b02.changes47.length,1);
 // The dictionary is put in force by a resource configuration: no new permission kind, record kind or protocol code.
 assert.ok(rule.includes('由一条资源配置决定生效'));
 const kinds=model.vocabulary.find((axis:{axis:string})=>axis.axis==='permission_kind').values.map((value:{code:string})=>value.code);
 assert.deepEqual(kinds,['publish','assign','publish_right','resource_config','share']);
});
