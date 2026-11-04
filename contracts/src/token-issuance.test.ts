import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {TokenIssuanceBody} from './tokens.ts';
import {TOKEN_ACTION,labelOf} from '../generated/vocabulary.ts';
import {RECORD_KINDS} from '../generated/protocol.ts';
const model=JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));
const user='usr_'+'0'.repeat(26),admin='usr_'+'1'.repeat(26),token='tok_'+'2'.repeat(26),invitation='inv_'+'3'.repeat(26),client='cli_'+'4'.repeat(26),at='2026-11-04T00:00:00.000Z';
test('model 38 adds the token_issuance kind and the R01 token_action axis with its rule',()=>{
 assert.ok((RECORD_KINDS as readonly string[]).includes('token_issuance'));
 assert.deepEqual(TOKEN_ACTION,['issue','use','revoke']);assert.deepEqual(TOKEN_ACTION.map(code=>labelOf('token_action',code)),['签发','使用','吊销']);
 const r01=model.elements.find((e:{id:string})=>e.id==='R01');assert.ok(r01.rules[12].includes('token_issuance')&&r01.rules[12].includes('决定 136 ⑫'));assert.ok(r01.changes38[0].includes('token_action'));
});
test('token issuance bodies are closed shapes of identifiers and times only',()=>{
 const shapes=[
  {action:'issue',token,user,by:admin,at,label:'合成笔记本',client:null,console_session:false,expires_at:null},
  {action:'issue',token,user:admin,by:null,at,label:'引导',client:null,console_session:false,expires_at:null},
  {action:'issue',token,user,by:user,at,label:'控制台登录',client:null,console_session:true,expires_at:at},
  {action:'issue',token,user,by:user,at,label:'合成客户端',client,console_session:false,expires_at:null},
  {action:'revoke',token,user,by:admin,at},
  {action:'revoke',token,user,by:admin,at,member_deletion:'00000000-0000-4000-8000-000000000001'},
  {action:'issue',invitation,user,by:admin,at,expires_at:at},
  {action:'use',invitation,user,client,at},
 ];
 for(const body of shapes)assert.deepEqual(TokenIssuanceBody.parse(body),body);
 for(const body of shapes)for(const extra of [{sha256:'a'.repeat(64)},{token_value:'synthetic'},{code:'ABCD-EFGH-JKMN'},{secret:'synthetic'}])assert.throws(()=>TokenIssuanceBody.parse({...body,...extra}));
 // An action belongs to its subject: invitations are not revoked, tokens are not "used" by a record.
 assert.throws(()=>TokenIssuanceBody.parse({action:'use',token,user,client,at}));
 assert.throws(()=>TokenIssuanceBody.parse({action:'revoke',invitation,user,by:admin,at}));
 assert.throws(()=>TokenIssuanceBody.parse({action:'issue',token,invitation,user,by:admin,at,expires_at:at}));
 assert.throws(()=>TokenIssuanceBody.parse({action:'issue',invitation,user,by:null,at,expires_at:at}));
 assert.throws(()=>TokenIssuanceBody.parse({action:'issue',token,user,by:admin,at,label:'x'.repeat(101),client:null,console_session:false,expires_at:null}));
});
