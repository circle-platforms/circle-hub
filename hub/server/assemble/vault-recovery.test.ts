import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Vault} from '../../records/api.ts';
import {AssemblyError} from './errors.ts';
import {requireVaultKey} from './vault.ts';

test('recovery hint reissues the missing operator token before secret import and starts service last',async()=>{
 const vault:Vault={initKey:async()=>{},put:async()=>{},get:async()=>{throw new Error('synthetic missing key');},getText:async()=>null,has:async()=>false,list:async()=>['synthetic-sealed'],remove:async()=>false};
 await assert.rejects(requireVaultKey({vault}),error=>{
  if(!(error instanceof AssemblyError) || !error.hint)return false;
  const hint=error.hint;assert.ok(hint.includes('key init --set-aside-vault'));
  assert.ok(hint.indexOf('operator-token reissue')<hint.indexOf('secret import'),hint);
  assert.ok(hint.indexOf('secret import')<hint.indexOf('最后起服务'),hint);return true;
 });
});
