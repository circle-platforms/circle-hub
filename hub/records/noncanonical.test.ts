import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';
import { newId, recordDigest } from './api.ts';

const NOW = '2026-10-23T00:00:00.000Z';
test('canonical records retain the fast path; noncanonical equivalent bodies are readable with an explicit note', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 2)); t.after(() => db.end());
  const input = { kind: 'action' as const, schema: 'action@1', provenance: 'observed' as const, created_at: NOW, body: { second: '合成', first: 1 } };
  const canonical = await kit.store.put(input); assert.deepEqual((await kit.store.get(canonical.digest))!.body, input.body);
  const legacy = { ...input, created_at: '2026-10-23T00:00:00.001Z' };
  const digest = recordDigest(legacy); const id = newId('rcd');
  const text = '{ "second": "合成", "first": 1 }';
  await db.query('INSERT INTO records (id,digest,kind,schema,provenance,created_at,body,size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, digest, legacy.kind, legacy.schema, legacy.provenance, legacy.created_at, text, Buffer.byteLength(text)]);
  const read=await kit.store.get(digest);assert.deepEqual(read!.body,legacy.body);
  assert.equal(read!.integrity_note,'正文不是规范写法、内容与摘要一致');
  assert.equal((await kit.store.get(canonical.digest))!.integrity_note,undefined);
  const { recordIntegrityNotes } = await import('./store.ts');
  const before = recordIntegrityNotes().readings;
  await kit.store.get(canonical.digest);
  assert.equal(recordIntegrityNotes().readings, before);
  const note = recordIntegrityNotes().entries.find(n => n.digest === digest)!;
  assert.equal(note.record, id); assert.equal(note.explanation, '正文不是规范写法、内容与摘要一致');
  assert.equal(note.readings, 1);
  assert.equal((await db.query('SELECT body FROM records WHERE digest=$1', [digest])).rows[0].body, text);
});

test('changed content and ambiguous duplicate-member JSON remain integrity failures', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 2)); t.after(() => db.end());
  for (const [at, text] of ['{ "a": 2 }', '{"a":2,"a":1}'].entries()) {
    const created_at = new Date(Date.parse(NOW) + at).toISOString();
    const digest = recordDigest({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at, body: { a: 1 } });
    await db.query('INSERT INTO records (id,digest,kind,schema,provenance,created_at,body,size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [newId('rcd'), digest, 'action', 'action@1', 'observed', created_at, text, Buffer.byteLength(text)]);
    await assert.rejects(kit.store.get(digest), /摘要不符|存储被改动|不能规范/);
  }
});


test('entry timestamp candidates preserve readable noncanonical order, whitespace and escaped headers without changing the stored text',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const db=new Database(createPool(kit.database,2));t.after(()=>db.end());
 const at='2026-11-03T02:00:00.000Z';
 const cases=[{at,body:{content:'合成正文',at},text:'{ "content": "合成正文", "at": "'+at+'" }'},{at,body:{at,content:'合成\0正文'},text:'{ "\\u0061t": "'+at+'", "content": "合成\\u0000正文" }'}];
 const ids:string[]=[];
 for(let i=0;i<cases.length;i++){const item=cases[i],created_at=new Date(Date.parse(NOW)+i).toISOString(),meta={kind:'knowledge_space_entry' as const,schema:'synthetic-header@1',provenance:'declared' as const,created_at},digest=recordDigest({...meta,body:item.body});
  await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,meta.kind,meta.schema,meta.provenance,created_at,item.text,Buffer.byteLength(item.text)]);ids.push(digest);
 }
 assert.deepEqual(await kit.store.entryTimes!(ids),new Map(ids.map(id=>[id,at])));
 assert.deepEqual(await kit.store.entryCandidates!({digests:ids,offset:0,limit:1}),{items:[{index:0,at}],total:2});
 assert.deepEqual(await kit.store.entryCandidates!({digests:ids,offset:1,limit:1}),{items:[{index:1,at}],total:2});
 const runBody={run:newId('run'),started_at:at,parameter:'合成\0参数'},runMeta={kind:'run' as const,schema:'synthetic-order@1',provenance:'declared' as const,created_at:NOW},runDigest=recordDigest({...runMeta,body:runBody}),runText=JSON.stringify({parameter:runBody.parameter,started_at:at,run:runBody.run},null,2);
 await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),runDigest,runMeta.kind,runMeta.schema,runMeta.provenance,NOW,runText,Buffer.byteLength(runText)]);
 const runs=await kit.store.runCandidates!({limit:1});assert.equal(runs[0].digest,runDigest);assert.deepEqual(runs[0].body,runBody);assert.ok(runs[0].integrity_note);

 for(let i=0;i<ids.length;i++){assert.deepEqual((await kit.store.get(ids[i]))?.body,cases[i].body);assert.equal((await db.query('SELECT body FROM records WHERE digest=$1',[ids[i]])).rows[0].body,cases[i].text);}
});
