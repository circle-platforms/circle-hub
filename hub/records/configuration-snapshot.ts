// Owner-only reset state. No vault, environment-file, login-reset, publication or create-user API is called here.
import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { RecordsConfig, Transaction } from './api.ts';
import { Database, createPool } from './db.ts';
import { PgRecordStore } from './store.ts';
import { canonicalize } from './canonical.ts';
import { sha256Hex } from './digest.ts';
import { FileObjectStore } from './objects.ts';
import { RecordsError } from './errors.ts';
import { compareRecordMigrations } from './schema-compatibility.ts';
import type { RecordMigrationReceipt } from './schema-compatibility.ts';
import type { ConfigurationSnapshot, ConfigurationRow } from './configuration-snapshot-types.ts';
import {captureConfigurationAuthentication,restoreConfigurationAuthentication,validateConfigurationAuthentication,CONFIGURATION_AUTH_TABLES} from './configuration-authentication.ts';
import { captureConfigurationClosure, validateConfigurationClosure } from './configuration-closure.ts';

const format='circle-hub-configuration-snapshot@1';
const Header=z.strictObject({format:z.literal(format),captured_at:z.string().min(1),migrations:z.array(z.strictObject({version:z.number().int().positive(),name:z.string(),sha256:z.string()})),authentication:z.unknown(),records:z.unknown(),indexes:z.unknown(),keys:z.unknown(),objects:z.unknown(),packages:z.unknown(),teams:z.unknown(),team_members:z.unknown(),pointers:z.unknown(),lease_registrations:z.unknown(),object_holds:z.unknown(),personal:z.unknown()});
const supportTables=['personal_spaces','personal_payloads','personal_record_bindings','personal_objects','personal_purges'] as const;
const managedTables=[...CONFIGURATION_AUTH_TABLES,'records','record_index','record_keys','objects','teams','team_members','pointers','lease_registrations','object_holds',...supportTables] as const;

async function assertCurrentSchema(db:Database,tx:Transaction):Promise<RecordMigrationReceipt[]> {
  const rows=(await db.query<{version:number;name:string;sha256:string}>('SELECT version,name,sha256 FROM public.schema_migrations ORDER BY version',[],tx)).rows;
  const receipts=rows.map(row=>({version:Number(row.version),name:row.name,sha256:row.sha256}));
  if(compareRecordMigrations(receipts).status!=='compatible')throw new RecordsError('记录库与当前版本不兼容，不能导出或恢复受保护配置；请归档并初始化，或使用当前定义文件恢复');
  return receipts;
}

function checkedConfigurationSnapshot(input:unknown):ConfigurationSnapshot {
  const header=Header.safeParse(input);
  if(!header.success)throw new RecordsError('受保护配置快照头不完整或格式不符；请用当前版本重新导出');
  if(compareRecordMigrations(header.data.migrations).status!=='compatible')throw new RecordsError('受保护配置快照不是当前数据库结构，不能恢复；请使用当前定义文件');
  const authentication=validateConfigurationAuthentication(header.data.authentication);
  const closure=validateConfigurationClosure(input);
  return {...closure,format,captured_at:header.data.captured_at,migrations:header.data.migrations,authentication};
}

export function validateConfigurationSnapshot(input:unknown):ConfigurationSnapshot {
  try{return checkedConfigurationSnapshot(input);}
  catch(error){if(error instanceof RecordsError)throw error;throw new RecordsError('配置快照的结构、正文或摘要无法核对；请用当前版本重新导出');}
}

export async function exportConfigurationSnapshot(config:RecordsConfig):Promise<ConfigurationSnapshot> {
  const db=new Database(createPool(config.database,1));
  try {
    return await db.transaction(async tx=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',[],tx);
      const migrations=await assertCurrentSchema(db,tx);
      const authentication=await captureConfigurationAuthentication(db,tx);
      const closure=await captureConfigurationClosure(config,db,tx);
      return validateConfigurationSnapshot({...closure,format,migrations,authentication,captured_at:new Date().toISOString()});
    });
  } catch(error) {
    if(error instanceof RecordsError)throw error;
    throw new RecordsError('当前配置未能完整导出；未生成可恢复快照，请检查数据库连接、读取权限及配置原件后重试');
  } finally { await db.end(); }
}

async function insertRows(db:Database,table:typeof managedTables[number],rows:readonly ConfigurationRow[],tx:Transaction):Promise<void> {
  if(rows.length)await db.query(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_recordset(NULL::public.${table},$1::jsonb)${table==='object_holds'?' ON CONFLICT DO NOTHING':''}`,[JSON.stringify(rows)],tx);
}

export async function restoreConfigurationSnapshot(config:RecordsConfig,input:ConfigurationSnapshot):Promise<void> {
  const snapshot=validateConfigurationSnapshot(input);
  if(!isAbsolute(config.dataDir))throw new RecordsError('恢复配置需要绝对路径的数据目录');
  const db=new Database(createPool(config.database,1));
  try {
    await db.transaction(async tx=>{
      await assertCurrentSchema(db,tx);
      await db.query('LOCK TABLE '+managedTables.map(table=>'public.'+table).join(',')+' IN ACCESS EXCLUSIVE MODE',[],tx);
      for(const table of managedTables)if((await db.query(`SELECT 1 FROM public.${table} LIMIT 1`,[],tx)).rowCount)throw new RecordsError('恢复目标不是空白的当前版本记录库；未写入配置，请先由重建控制器归档并初始化');
      const personalOwners=new Set(snapshot.personal.personal_spaces.map(row=>String(row.owner)));
      const stagedUsers=snapshot.authentication.users.map(row=>{
        if(!personalOwners.has(String(row.id)))return row;
        if(row.deleted_at!==null)throw new RecordsError('快照含有删除尚未完成的个人配置；请先完成该删除再重新导出');
        return row.disabled?{...row,disabled:false}:row;
      });
      // No staged account state is visible outside this restore transaction.
      await restoreConfigurationAuthentication(db,{...snapshot.authentication,users:stagedUsers},tx);
      for(const table of ['personal_spaces','personal_payloads','personal_record_bindings','personal_objects','personal_purges'] as const)await insertRows(db,table,snapshot.personal[table],tx);
      await mkdir(join(config.dataDir,'objects'),{recursive:true,mode:0o700});
      const objects=new FileObjectStore(join(config.dataDir,'objects'),db,{maxBytes:snapshot.objects.reduce((max,row)=>Math.max(max,row.size),config.limits.maxUploadBytes),now:()=>new Date(),personalPayloads:new PgRecordStore(db,{maxRecordBytes:config.limits.maxRecordBytes,now:()=>new Date()}).personalPayloads});
      for(const object of snapshot.objects){
        await db.query('INSERT INTO public.objects(sha256,size,media_type,created_at) VALUES($1,$2,$3,$4)',[object.sha256,object.size,object.media_type,object.created_at],tx);
        if(object.public)await objects.put(Buffer.from(object.bytes_base64,'base64'),object.media_type,tx);
      }
      for(const record of [...snapshot.records].sort((a,b)=>BigInt(a.seq)<BigInt(b.seq)?-1:BigInt(a.seq)>BigInt(b.seq)?1:0)){
        await db.query('INSERT INTO public.records(seq,id,digest,kind,schema,provenance,created_at,body,size) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[record.seq,record.id,record.digest,record.kind,record.schema,record.provenance,record.created_at,record.body,record.size],tx);
      }
      for(const row of snapshot.indexes)await db.query('INSERT INTO public.record_index(key,value,digest,record_seq) VALUES($1,$2,$3,$4)',[row.key,row.value,row.digest,row.record_seq],tx);
      for(const row of snapshot.keys)await db.query('INSERT INTO public.record_keys(kind,key,digest) VALUES($1,$2,$3)',[row.kind,row.key,row.digest],tx);
      for(const table of ['teams','team_members','pointers','lease_registrations','object_holds'] as const)await insertRows(db,table,snapshot[table],tx);
      await db.query("SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('public.records','seq'),GREATEST(COALESCE((SELECT max(seq) FROM public.records),0)+1,1),false)",[],tx);
      for(const object of snapshot.objects){
        const row=(await db.query<{size:string;media_type:string}>('SELECT size::text,media_type FROM public.objects WHERE sha256=$1',[object.sha256],tx)).rows[0];
        if(!row||Number(row.size)!==object.size||row.media_type!==object.media_type)throw new RecordsError('配置原件恢复后的登记不一致；事务已拒绝');
        const bytes=await objects.get(object.sha256,tx);if(!bytes||sha256Hex(bytes)!==object.sha256)throw new RecordsError('配置原件恢复后的字节不完整；事务已拒绝');
      }
      for(const row of snapshot.authentication.users)if(personalOwners.has(String(row.id))&&row.disabled)await db.query('UPDATE public.users SET disabled=true WHERE id=$1',[row.id],tx);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE',[],tx);
      const restored=await captureConfigurationAuthentication(db,tx);
      for(const table of CONFIGURATION_AUTH_TABLES){
        const order=(rows:ConfigurationRow[])=>[...rows].sort((a,b)=>String(a.id??a.seq).localeCompare(String(b.id??b.seq)));
        if(canonicalize(order(restored[table]))!==canonicalize(order(snapshot.authentication[table])))throw new RecordsError('恢复后的认证状态与原快照不同；事务已拒绝');
      }
      await assertCurrentSchema(db,tx);
    });
  } catch(error) {
    if(error instanceof RecordsError)throw error;
    throw new RecordsError('配置恢复未能确认完成；请由重建控制器恢复归档后重试，不要删除归档或密钥库');
  } finally { await db.end(); }
}
