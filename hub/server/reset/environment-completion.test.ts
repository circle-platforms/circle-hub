import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBytes, sha256Hex, newId } from '../../records/api.ts';
import { TEST_ENVIRONMENT_INHERITANCE_KEY } from '../../../contracts/src/resources.ts';
import type { SqlSession } from '../../platform/api.ts';
import { inspectCurrentState } from './current.ts';

const at = '2026-11-14T00:00:00.000Z';
function fixture() {
  const user = newId('usr'), source = 'a'.repeat(64), marker = 'b'.repeat(64);
  const content = canonicalBytes({schema:'test-environment-inheritance-completion@1',rule_version:1,completed_at:at,source_records:[source],grant_records:[],environment_ids:[]});
  const bound = sha256Hex(content);
  const rows = [
    {digest:source,kind:'action',schema:'action@1',body:JSON.stringify({action:'validate',component:'runs.engine@1',detail:{},run:null,item:null,inputs:[],lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[]})},
    {digest:marker,kind:'authorization',schema:'authorization@1',body:JSON.stringify({permission:'resource_config',subject:'*',object:TEST_ENVIRONMENT_INHERITANCE_KEY,revoked:false,bound,decided_by:user,decided_at:at,expires_at:null,note:null,supersedes:null})},
  ];
  const session: SqlSession = {query:async sql=>{
    if (sql.startsWith('WITH logical')) return rows;
    if (sql.startsWith('SELECT digest,key,value')) return [];
    if (sql.startsWith('SELECT record,sha256,artifact')) return [];
    if (sql.startsWith('SELECT sha256')) return [{sha256:bound}];
    if (sql.startsWith('SELECT tablename') || sql.includes('FROM pg_constraint')) return [];
    throw new Error('unimplemented synthetic reset query: '+sql);
  },close:async()=>{}};
  return {session,content,bound,source,marker};
}

test('partial reset cannot erase sources retained by the ordinary completion record', async () => {
  const f = fixture();
  const state = await inspectCurrentState(f.session,{scopes:['history'],keepConfig:true},async hash=>hash===f.bound?f.content:null);
  assert.ok(state.selection.retained.includes(f.marker));
  assert.ok(state.blocked.length>0);
  assert.ok(state.blocked.some(problem=>problem.reason.includes('引用') || problem.reason.includes('依赖')));
});

test('missing completion bytes block reset rather than removing evidence of prior inheritance', async () => {
  const f = fixture();
  const state = await inspectCurrentState(f.session,{scopes:['history'],keepConfig:true},async()=>null);
  assert.ok(state.blocked.some(problem=>problem.reason==='测试环境登记或分配继承记录的原件不能核对'));
});
