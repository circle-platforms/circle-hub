// Run admission and the same migration backfill must decode only indexed, hash-matching source registrations.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {MIGRATIONS} from './migrations.ts';
import {newId} from './ids.ts';

test('twenty declarations use indexed candidates among 100000 sources in both the trigger and backfill',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const db=new Database(createPool(kit.database));t.after(()=>db.end());
 const {user:owner}=await kit.principals.bootstrapAdmin('synthetic-declaration-index');
 // Metadata-only synthetic unrelated sources: no original, payload or business text is copied into the fixture.
 await db.query(`WITH inserted AS (
  INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size)
  SELECT 'rcd_'||lpad(n::text,26,'0'),lpad(to_hex(n),64,'0'),'knowledge_space_source','knowledge-space-source@1','declared',now(),
   json_build_object('space',$1::text,'sha256',repeat('f',56)||lpad(to_hex(n),8,'0'),'artifact',NULL)::text,200
  FROM generate_series(1,100000) n RETURNING digest,seq,body
 ) INSERT INTO record_index(key,value,digest,record_seq) SELECT 'knowledge.space.source_hash',body::jsonb->>'sha256',digest,seq FROM inserted`,[owner.id]);
 const upload=(text:string,session:string)=>kit.artifacts.ingest({bytes:Buffer.from(text),mediaType:'text/plain',name:'synthetic.txt',origin:{upload:{session}},author:{user:owner.id},provenanceType:'declared',visibility:{readers:[owner.id],admins:false,packs:[],shareable:false}});
 const captures:Awaited<ReturnType<typeof upload>>[]=[];for(let n=0;n<20;n++)captures.push(await upload('synthetic declaration '+n,'synthetic-'+n));
 const associate=async(artifact:typeof captures[number],space:string)=>kit.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space,path:'/',sha256:artifact.body.sha256,artifact:artifact.digest,size:artifact.body.size,by:owner.id,at:new Date().toISOString()},index:[{key:'knowledge.space.source_hash',value:artifact.body.sha256}]});
 await associate(captures[1],owner.id);await associate(captures[2],'team');
 const equal=await upload('synthetic declaration 3','synthetic-separate-equal-byte-capture');assert.notEqual(equal.digest,captures[3].digest);await associate(equal,owner.id);
 const run=()=>kit.store.put({kind:'run',schema:'run@1',provenance:'declared',body:{run:newId('run'),runner:owner.id,sources:captures.map((capture,n)=>({reference:'src:'+capture.body.sha256,artifact:capture.digest,slot:'synthetic-'+n,upload_declaration:{by:owner.id}}))}});
 await db.query('ALTER TABLE records DISABLE TRIGGER records_frozen_uploads');
 let earlier:Awaited<ReturnType<typeof run>>;try{earlier=await run();}finally{await db.query('ALTER TABLE records ENABLE TRIGGER records_frozen_uploads');}
 await associate(captures[4],owner.id);await db.query('ANALYZE records');await db.query('ANALYZE record_index');
 const began=performance.now(),current=await run();
 const declarations=async(record:string)=>(await db.query<{artifact:string}>('SELECT artifact FROM run_upload_declarations WHERE run_record=$1 ORDER BY artifact',[record])).rows.map(row=>row.artifact);
 assert.deepEqual(await declarations(current.digest),captures.filter((_,n)=>n!==1&&n!==4).map(c=>c.digest).sort());
 assert.deepEqual(await declarations(earlier!.digest),[]);
 const migration=MIGRATIONS.find(m=>m.version===21)!;
 const backfill=migration.sql.match(/DO \$backfill\$[\s\S]+?END \$backfill\$;/);assert.ok(backfill);await db.query(backfill[0]);
 assert.deepEqual(await declarations(earlier!.digest),captures.filter((_,n)=>n!==1).map(c=>c.digest).sort(),'later registration must not rewrite the frozen declaration boundary');
 await db.query(backfill[0]);assert.equal((await declarations(earlier!.digest)).length,19,'backfill remains idempotent');
 t.diagnostic('20-upload run plus two backfills among 100000 unrelated sources: '+Math.round(performance.now()-began)+' ms');

 // Explain the installed function's actual candidate query; do not maintain a separate optimized query in the test.
 const definition=(await db.query<{definition:string}>("SELECT pg_get_functiondef('public.hub_freeze_upload_declarations(text)'::regprocedure) AS definition")).rows[0].definition;
 const selection=definition.match(/IF EXISTS\((WITH candidates AS MATERIALIZED[\s\S]+?)\) THEN CONTINUE;END IF;/);assert.ok(selection);
 const query=selection[1].replaceAll("b->>'sha256'",'$1::pg_catalog.text').replaceAll('run_seq','$2::pg_catalog.int8').replaceAll('capture.digest','$3::pg_catalog.text');
 const seq=(await db.query('SELECT seq FROM records WHERE digest=$1',[current.digest])).rows[0].seq;
 type Plan={Plans?:Plan[];'Index Name'?:string;'Index Cond'?:string;'Node Type'?:string;'Relation Name'?:string};
 const explained=await db.query<{'QUERY PLAN':{Plan:Plan}[]}>('EXPLAIN (ANALYZE,FORMAT JSON) SELECT EXISTS('+query+')',[captures[1].body.sha256,seq,captures[1].digest]);
 const plan=JSON.stringify(explained.rows[0]['QUERY PLAN']);
 assert.match(plan,/(?:Index Scan|Index Only Scan|Bitmap Index Scan)/);assert.match(plan,/record_index/);assert.match(plan,/Index Cond[^\n]*knowledge\.space\.source_hash/);
 const visit=(node:Plan):Plan[]=>[node,...(node.Plans??[]).flatMap(visit)];
 assert.ok(visit(explained.rows[0]['QUERY PLAN'][0].Plan).some(node=>node['Index Name']?.startsWith('record_index')&&node['Index Cond']?.includes(captures[1].body.sha256)),'the source hash itself must constrain an index lookup');
 assert.ok(!visit(explained.rows[0]['QUERY PLAN'][0].Plan).some(node=>node['Node Type']==='Seq Scan'&&node['Relation Name']==='record_index'));
});
