// Database TEMP is unsafe even when inherited; both authorization and runtime startup must reject it.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {grantRuntime,verifyMigrations} from './migrations.ts';

test('runtime grants and startup refuse public, direct and inherited temporary privilege',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const db=new Database(createPool(kit.database));t.after(()=>db.end());
 const suffix=randomBytes(4).toString('hex'),role='synthetic_temp_'+suffix,parent='synthetic_temp_parent_'+suffix,password=randomBytes(16).toString('hex'),database='"'+kit.database.database+'"';
 await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await db.query(`CREATE ROLE ${parent}`);
 // PostgreSQL's default PUBLIC grant must be detected, not silently rewritten by grantRuntime.
 await db.query('GRANT TEMPORARY ON DATABASE '+database+' TO PUBLIC');await assert.rejects(grantRuntime(db,role),/临时对象/);
 assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[role,'public.personal_payloads','INSERT'])).rows[0].ok,false);
 await db.query('REVOKE TEMPORARY ON DATABASE '+database+' FROM PUBLIC');await grantRuntime(db,role);
 const rt=new Database(createPool({...kit.database,user:role,password},1));t.after(()=>rt.end());await verifyMigrations(rt);
 await assert.rejects(rt.query('CREATE TEMP TABLE synthetic_forbidden(n integer)'),(e:unknown)=>(e as {code:string}).code==='42501');
 await db.query('GRANT TEMPORARY ON DATABASE '+database+' TO "'+role+'"');await assert.rejects(grantRuntime(db,role),/临时对象/);await assert.rejects(verifyMigrations(rt),/临时对象/);
 await db.query('REVOKE TEMPORARY ON DATABASE '+database+' FROM "'+role+'"');await verifyMigrations(rt);
 await db.query('GRANT TEMPORARY ON DATABASE '+database+' TO "'+parent+'"');await db.query('GRANT "'+parent+'" TO "'+role+'"');await assert.rejects(grantRuntime(db,role),/临时对象/);await assert.rejects(verifyMigrations(rt),/临时对象/);
 await db.query('REVOKE "'+parent+'" FROM "'+role+'"');await verifyMigrations(rt);await verifyMigrations(db);
});
