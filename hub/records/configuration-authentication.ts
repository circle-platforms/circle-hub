import { z } from 'zod';
import { UserId, TokenId } from '../../contracts/api.ts';
import { Sha256 } from '../../contracts/src/common.ts';
import { PermissionRoleSchema, TokenScopeSchema } from '../../contracts/generated/vocabulary.ts';
import { RecordsError } from './errors.ts';
import type { Database } from './db.ts';
import type { Transaction } from './api.ts';
import type { ConfigurationAuthentication, ConfigurationRow } from './configuration-snapshot-types.ts';

const time=z.string().min(1),optionalTime=time.nullable(),id=z.string().min(1);
const schemas={
  users:z.strictObject({id:UserId,name:z.string(),role:PermissionRoleSchema,disabled:z.boolean(),created_at:time,updated_at:time,password_hash:z.string().nullable(),password_must_change:z.boolean(),password_revision:z.number().int().nonnegative(),deleted_at:optionalTime}),
  user_history:z.strictObject({seq:z.string().regex(/^[1-9][0-9]*$/),user_id:UserId,name:z.string(),role:PermissionRoleSchema,disabled:z.boolean(),changed_by:UserId.nullable(),changed_at:time,password_changed:z.boolean(),deleted_at:optionalTime}),
  oauth_clients:z.strictObject({id,name:z.string(),redirect_uris:z.array(z.string()),created_at:time}),
  tokens:z.strictObject({id:TokenId,user_id:UserId,sha256:Sha256,label:z.string(),created_at:time,created_by:UserId.nullable(),last_used_at:optionalTime,revoked_at:optionalTime,revoked_by:UserId.nullable(),client_id:id.nullable(),console_session:z.boolean(),expires_at:optionalTime,scope:z.array(TokenScopeSchema)}),
  invitations:z.strictObject({id,user_id:UserId,sha256:Sha256,created_at:time,created_by:UserId,expires_at:time,used_at:optionalTime,used_by_client:id.nullable()}),
} as const;
export const CONFIGURATION_AUTH_TABLES:readonly (keyof typeof schemas)[]=Object.freeze(Object.keys(schemas) as (keyof typeof schemas)[]);
const Authentication=z.strictObject({users:z.array(schemas.users),user_history:z.array(schemas.user_history),oauth_clients:z.array(schemas.oauth_clients),tokens:z.array(schemas.tokens),invitations:z.array(schemas.invitations)});

export function validateConfigurationAuthentication(input:unknown):ConfigurationAuthentication {
  const result=Authentication.safeParse(input);
  if(!result.success)throw new RecordsError('受保护快照的账户或认证字段不符合当前结构；请用当前版本重新导出，不能恢复这份快照');
  const state=result.data,users=new Set(state.users.map(row=>row.id)),clients=new Set(state.oauth_clients.map(row=>row.id));
  for(const table of CONFIGURATION_AUTH_TABLES){
    const keys=state[table].map(row=>'id'in row?row.id:row.seq);
    if(new Set(keys).size!==keys.length)throw new RecordsError('受保护快照存在重复认证行；不能恢复');
  }
  for(const row of state.user_history)if(!users.has(row.user_id)||row.changed_by!==null&&!users.has(row.changed_by))throw new RecordsError('认证快照缺少账户引用；不能恢复');
  for(const row of state.tokens)if(!users.has(row.user_id)||row.created_by!==null&&!users.has(row.created_by)||row.revoked_by!==null&&!users.has(row.revoked_by)||row.client_id!==null&&!clients.has(row.client_id))throw new RecordsError('认证快照缺少账户或客户端引用；不能恢复');
  for(const row of state.invitations)if(!users.has(row.user_id)||!users.has(row.created_by)||row.used_by_client!==null&&!clients.has(row.used_by_client))throw new RecordsError('邀请码快照缺少账户或客户端引用；不能恢复');
  return state;
}

export async function captureConfigurationAuthentication(db:Database,tx:Transaction):Promise<ConfigurationAuthentication> {
  const state={} as ConfigurationAuthentication;
  for(const table of CONFIGURATION_AUTH_TABLES){
    const body=table==='user_history'?"to_jsonb(t)||jsonb_build_object('seq',t.seq::text)":'to_jsonb(t)';
    const order=table==='user_history'?'seq':'id';
    state[table]=(await db.query<{state:ConfigurationRow}>(`SELECT ${body} AS state FROM public.${table} t ORDER BY ${order}`,[],tx)).rows.map(row=>row.state);
  }
  return validateConfigurationAuthentication(state);
}

export async function restoreConfigurationAuthentication(db:Database,input:ConfigurationAuthentication,tx:Transaction):Promise<void> {
  const state=validateConfigurationAuthentication(input);
  for(const table of ['users','oauth_clients','user_history','tokens','invitations'] as const){
    if(!state[table].length)continue;
    const overriding=table==='user_history'?' OVERRIDING SYSTEM VALUE':'';
    await db.query(`INSERT INTO public.${table}${overriding} SELECT * FROM jsonb_populate_recordset(NULL::public.${table},$1::jsonb)`,[JSON.stringify(state[table])],tx);
  }
  await db.query("SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('public.user_history','seq'),GREATEST(COALESCE((SELECT max(seq) FROM public.user_history),0)+1,1),false)",[],tx);
}
