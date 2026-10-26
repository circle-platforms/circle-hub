// Derived acceptance uses synthetic documents and randomly generated fake credentials only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { canonicalBytes, sha256Hex, type DerivedCoverageInput, type IngestInput, type Principal, type SourceArtifactBody } from './api.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());
const fake = () => `Ftp${randomBytes(8).toString('hex')}9`;
const line = (secret: string) => `copy ftp://user:${secret}@192.0.2.10/image.bin flash:`;
function readInput(bytes: Uint8Array): IngestInput {
  return {bytes,mediaType:'text/plain',origin:{read:{object:'synthetic:manual:one'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}};
}
function derived(bytes: Uint8Array, sources: string[]): IngestInput {
  return {...readInput(bytes),origin:{generated:{generator:'synthetic.derive@1',inputs:sources.map(s => `src:${s}`)}},provenanceType:'projected',derivedSources:sources};
}
async function world(t: {after(fn: () => Promise<void>): void}) {
  const kit = await openTestRecords({postgres}); t.after(() => kit.close());
  const {user} = await kit.principals.bootstrapAdmin('管理员');
  const admin: Principal = {id:user.id,name:user.name,role:user.role};
  const admitted = async (bytes: Uint8Array) => {
    const input = readInput(bytes); const held = await kit.artifacts.ingest(input);
    await kit.artifacts.acceptFindings(admin,held.body.sha256,'合成手册的虚构示例');
    return kit.artifacts.ingest(input);
  };
  return {kit,admin,admitted};
}
test('accepted originals cover changed offsets and JSON escaping, with a source-only receipt', async t => {
  const {kit,admin,admitted} = await world(t); const secret = fake();
  const source = await admitted(Buffer.from(`# 文档\n${line(secret)}\n`));
  const output = await kit.artifacts.ingest(derived(canonicalBytes({body:line(secret)}),[source.body.sha256]));
  assert.equal(output.body.read_tier,'model_readable');
  assert.equal(output.body.scan.accepted,undefined);
  assert.equal(output.body.scan.derived?.sources[0].sha256,source.body.sha256);
  assert.equal((await kit.artifacts.source(admin,output.body.sha256))?.acceptance?.kind,'derived');
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(secret),false);
  assert.equal(serialized.includes(sha256Hex(Buffer.from(secret))),false);
  await kit.artifacts.revokeFindings(admin,source.body.sha256,'撤回合成决定');
  assert.equal((await kit.artifacts.source(admin,output.body.sha256))?.bytes,null);
  assert.equal((await kit.artifacts.text(admin,output.body.sha256))?.readable,false);
});
test('every finding needs coverage and unrelated accepted bytes cannot be borrowed', async t => {
  const {kit,admitted} = await world(t); const first = fake(), second = fake();
  const a = await admitted(Buffer.from(line(first))), b = await admitted(Buffer.from(line(second)));
  const extra = await kit.artifacts.ingest(derived(Buffer.from(`${line(first)}\n${line(second)}`),[a.body.sha256]));
  assert.equal(extra.body.read_tier,'retain_only');
  const forged = derived(Buffer.from(`derived\n${line(second)}`),[b.body.sha256]); forged.origin = {generated:{generator:'synthetic.derive@1',inputs:[`src:${a.body.sha256}`]}};
  assert.equal((await kit.artifacts.ingest(forged)).body.read_tier,'retain_only');
  const covered = await kit.artifacts.ingest(derived(Buffer.from(`prefix\n${line(first)}\n${line(second)}`),[a.body.sha256,b.body.sha256]));
  assert.equal(covered.body.read_tier,'model_readable');
});
test('uploads, personal authors and a human intermediate never inherit acceptance', async t => {
  const {kit,admin,admitted} = await world(t); const source = await admitted(Buffer.from(line(fake())));
  const outputBytes = Buffer.from(`derived\n${Buffer.from((await kit.artifacts.trustedBytes(source.body.sha256))!).toString()}`);
  const person = {...derived(outputBytes,[source.body.sha256]),author:{user:admin.id}};
  assert.equal((await kit.artifacts.ingest(person)).body.read_tier,'retain_only');
  await assert.rejects(kit.artifacts.ingest({...person,origin:{upload:{session:'synthetic'}}}));
  const clean = await kit.artifacts.ingest({...readInput(Buffer.from('a person wrote this')),origin:{upload:{session:'synthetic'}},author:{user:admin.id}});
  const tainted = derived(outputBytes,[source.body.sha256]); tainted.origin = {generated:{generator:'synthetic.derive@1',inputs:[`src:${source.body.sha256}`,`src:${clean.body.sha256}`]}};
  assert.equal((await kit.artifacts.ingest(tainted)).body.read_tier,'retain_only');
});
test('a derived chain rechecks every acceptance and never ignores an explicitly retained input', async t => {
  const {kit,admin,admitted} = await world(t); const secret = fake();
  const source = await admitted(Buffer.from(line(secret)));
  const first = await kit.artifacts.ingest(derived(Buffer.from(`one\n${line(secret)}`),[source.body.sha256]));
  const second = await kit.artifacts.ingest(derived(Buffer.from(`two\n${line(secret)}`),[first.body.sha256]));
  assert.equal(second.body.read_tier,'model_readable');
  await kit.artifacts.revokeFindings(admin,source.body.sha256);
  assert.equal((await kit.artifacts.source(admin,second.body.sha256))?.bytes,null);
  const retained = await kit.artifacts.ingest({...derived(Buffer.from(`kept\n${line(secret)}`),[source.body.sha256]),readTier:'retain_only'});
  assert.equal(retained.body.read_tier,'retain_only');
});
test('complete derived scans may exceed the display cap while unaccepted truncated sources still cannot cover', async t => {
  const {kit,admin,admitted} = await world(t); const secret = fake();
  const source = await admitted(Buffer.from(line(secret)));
  const many = Buffer.from(Array.from({length:101},(_,i) => `${i}: ${line(secret)}`).join('\n'));
  const output = await kit.artifacts.ingest(derived(many,[source.body.sha256]));
  assert.equal(output.body.scan.truncated,false);assert.equal(output.body.scan.findings.length,101);assert.equal(output.body.read_tier,'model_readable');
  assert.ok((await kit.artifacts.source(admin,output.body.sha256))?.bytes);
  const held = await kit.artifacts.ingest(readInput(many));
  await assert.rejects(kit.artifacts.acceptFindings(admin,held.body.sha256));
  assert.equal((await kit.artifacts.ingest(derived(Buffer.from(`target\n${line(secret)}`),[held.body.sha256]))).body.read_tier,'retain_only');
});
test('coverage metadata, database rows and call logs contain neither matches nor their digests', async t => {
  const {kit,admin,admitted} = await world(t); const secret = fake();
  const source = await admitted(Buffer.from(line(secret)));
  const artifact = await kit.artifacts.ingest(derived(canonicalBytes({body:line(secret)}),[source.body.sha256]));
  await kit.callLog.append({at:'2026-10-23T00:00:00.000Z',traceId:'a'.repeat(32),spanId:'b'.repeat(16),userId:admin.id,sessionId:null,tool:'synthetic.derive',runId:null,arguments:{text:line(secret),source:source.body.sha256,output:artifact.body.sha256},callResult:'ok',acceptance:null,errorCode:null,durationMs:1});
  const files = (await readdir(kit.config.logDir)).filter(name => /^calls-.*\.jsonl$/.test(name));
  assert.equal(files.length,1,'the assertion must inspect a written call log');
  const logs = (await Promise.all(files.map(name => readFile(join(kit.config.logDir,name),'utf8')))).join('\n');
  assert.equal(logs.trim().split('\n').length,1);
  for (const forbidden of [secret,line(secret),sha256Hex(Buffer.from(secret))]) assert.equal(logs.includes(forbidden),false);
  const client = new pg.Client({...kit.database,ssl:false}); await client.connect();
  try {
    const rows: unknown[] = [];
    for (const table of ['records','record_index','objects','call_logs','call_notes']) rows.push((await client.query(`SELECT * FROM ${table}`)).rows);
    const text = JSON.stringify([rows,artifact]);
    for (const forbidden of [secret,line(secret),sha256Hex(Buffer.from(secret)),sha256Hex(Buffer.from(`ftp://user:${secret}@1`))]) assert.equal(text.includes(forbidden),false);
  } finally { await client.end(); }
});
test('a matching private-key header never covers different key material', async t => {
  const {kit,admitted} = await world(t);
  const pem = (value: string) => ['-----BEGIN ', 'PRIVATE KEY-----\n', value.repeat(40), '\n-----END ', 'PRIVATE KEY-----'].join('');
  const source = await admitted(Buffer.from(pem('A1')));
  assert.equal((await kit.artifacts.ingest(derived(Buffer.from(`prefix\n${pem('B2')}`),[source.body.sha256]))).body.read_tier,'retain_only');
  assert.equal((await kit.artifacts.ingest(derived(canonicalBytes({key:pem('A1')}),[source.body.sha256]))).body.read_tier,'model_readable');
});
test('multiple decoded matches at one reported position each need coverage', async t => {
  const {kit,admitted} = await world(t); const a = fake(), b = fake();
  const source = await admitted(Buffer.from(`password = ${a}`));
  const hidden = JSON.stringify(`password = ${b}`).replace('password','\\u0070assword');
  const output = Buffer.from(JSON.stringify(`password = ${a}; ${hidden}`));
  assert.equal((await kit.artifacts.ingest(derived(output,[source.body.sha256]))).body.read_tier,'retain_only');
  const both = await admitted(Buffer.from(`password = ${a}\npassword = ${b}`));
  assert.equal((await kit.artifacts.ingest(derived(output,[both.body.sha256]))).body.read_tier,'model_readable');
});
test('exact matched values cannot inherit through a trimmed prefix', async t => {
  const {kit,admitted} = await world(t); const secret = fake();
  const source = await admitted(Buffer.from(`password = ${secret}`));
  assert.equal((await kit.artifacts.ingest(derived(canonicalBytes({password:secret}),[source.body.sha256]))).body.read_tier,'model_readable');
  assert.equal((await kit.artifacts.ingest(derived(canonicalBytes({password:secret+'!'}),[source.body.sha256]))).body.read_tier,'retain_only');
});
test('an equal-byte Hub input cannot hide a separately pinned human input', async t => {
  const {kit,admin,admitted} = await world(t); const text = line(fake());
  const source = await admitted(Buffer.from(text));
  const human = await kit.artifacts.ingest({...readInput(Buffer.from(text)),author:{user:admin.id}});
  const input = derived(Buffer.from(`copy\n${text}`),[source.body.sha256]);
  input.origin = {generated:{generator:'synthetic.derive@1',inputs:[`rec:${source.digest}`,`rec:${human.digest}`]}};
  assert.equal((await kit.artifacts.ingest(input)).body.read_tier,'retain_only');
});
test('acceptance and withdrawal notes cannot copy a decoded match hidden behind another finding', async t => {
  const {kit,admin} = await world(t); const a = fake(), b = fake();
  const escaped = [...b].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join('');
  const hidden = `"password = ${escaped}"`;
  const bytes = Buffer.from(JSON.stringify(`password = ${a}; ${hidden}`));
  const source = await kit.artifacts.ingest(readInput(bytes));
  const copied = `已经人工核对 ${b}`;
  await assert.rejects(kit.artifacts.acceptFindings(admin,source.body.sha256,copied),e => e instanceof Error && !e.message.includes(b));
  await kit.artifacts.acceptFindings(admin,source.body.sha256,'合成文档中的虚构写法');
  await assert.rejects(kit.artifacts.revokeFindings(admin,source.body.sha256,copied),e => e instanceof Error && !e.message.includes(b));
});
test('a prepared matcher is origin-bound and cannot admit a stale acceptance after withdrawal', async t => {
  const {kit,admin,admitted} = await world(t); const secret=fake();
  const source = await admitted(Buffer.from(line(secret)));
  const input = derived(Buffer.from(`prepared\n${line(secret)}`),[source.body.sha256]);
  const handle = await kit.artifacts.prepareDerived({origin:input.origin,author:input.author,derivedSources:input.derivedSources!});
  assert.ok(handle.assess(input.bytes).derived);
  await assert.rejects(kit.artifacts.ingest({...input,origin:{generated:{generator:'synthetic.other@1',inputs:[]}},derivedCoverage:handle}),TypeError);
  await kit.artifacts.revokeFindings(admin,source.body.sha256);
  assert.equal((await kit.artifacts.ingest({...input,derivedCoverage:handle})).body.read_tier,'retain_only');
});
test('a current acceptance covers a stored scan hold, while an explicit retention request stays retained', async t => {
  const {kit,admin} = await world(t); const secret=fake();
  const input=readInput(Buffer.from(line(secret)));
  const held=await kit.artifacts.ingest(input);
  await kit.artifacts.acceptFindings(admin,held.body.sha256,'合成手册的虚构示例');
  assert.equal(held.body.read_tier,'retain_only');
  assert.equal((await kit.artifacts.source(admin,held.body.sha256,{record:held.digest}))?.readTier,'model_readable');
  const output=await kit.artifacts.ingest(derived(Buffer.from(`current\n${line(secret)}`),[held.body.sha256]));
  assert.equal(output.body.read_tier,'model_readable');
  const explicit=await kit.artifacts.ingest({...input,readTier:'retain_only'});
  assert.equal((await kit.artifacts.source(admin,held.body.sha256,{record:explicit.digest}))?.readTier,'retain_only');
});
test('read operations over admitted multi-megabyte bytes use stored scan facts without scanning them', async t => {
  const kit=await openTestRecords({postgres});
  const {user:admin}=await kit.principals.bootstrapAdmin('合成管理员');
  const {openRecords} = await import('./index.ts');
  let scans=0,bytes=0;
  let counted: Awaited<ReturnType<typeof openRecords>> | undefined;
  t.after(async()=>{await counted?.close();await kit.close();});
  counted=await openRecords({dataDir:kit.dataDir,logDir:kit.config.logDir,database:kit.database,limits:kit.config.limits},{migrate:false,keyProvider:kit.keyProvider,onCredentialScan:length=>{scans++;bytes+=length;}});
  const input=readInput(Buffer.from('synthetic plain text\n'.repeat(100_000)+line(fake())));
  const held=await counted.artifacts.ingest(input);
  await counted.artifacts.acceptFindings(admin,held.body.sha256,'合成文件中的虚构示例');
  let objectReads=0;
  const get=counted.objects.get.bind(counted.objects);
  t.mock.method(counted.objects,'get',async (sha: string)=>{objectReads++;return get(sha);});
  scans=0;bytes=0;
  assert.equal((await counted.artifacts.source(admin,held.body.sha256,{record:held.digest}))?.bytes?.length,input.bytes.byteLength);
  assert.equal((await counted.artifacts.text(admin,held.body.sha256))?.readable,true);
  assert.ok(await counted.artifacts.readable(admin,held.body.sha256));
  assert.deepEqual({scans,bytes},{scans:0,bytes:0});
  assert.equal(objectReads,2,'only source() and text() fetch the requested bytes; metadata checks never fetch bytes');
});
test('derived reads validate stored coverage and live withdrawal without scanning bytes', async t => {
  const {kit,admin,admitted}=await world(t);
  const source=await admitted(Buffer.from(line(fake())));
  const original=await kit.artifacts.trustedBytes(source.body.sha256); assert.ok(original);
  const input=derived(Buffer.concat([Buffer.from('synthetic derived text\n'.repeat(100_000)),Buffer.from(original)]),[source.body.sha256]);
  const output=await kit.artifacts.ingest(input);
  assert.equal(output.body.scan.accepted,undefined);
  assert.ok(output.body.scan.derived);
  const {openRecords}=await import('./index.ts');
  let scans=0,bytes=0;
  const counted=await openRecords({dataDir:kit.dataDir,logDir:kit.config.logDir,database:kit.database,limits:kit.config.limits},{migrate:false,keyProvider:kit.keyProvider,onCredentialScan:length=>{scans++;bytes+=length;}});
  t.after(()=>counted.close());
  const read=await counted.artifacts.source(admin,output.body.sha256,{record:output.digest});
  assert.equal(read?.acceptance?.kind,'derived');
  assert.deepEqual(read?.bytes,input.bytes);
  assert.equal((await counted.artifacts.text(admin,output.body.sha256))?.readable,true);
  assert.ok(await counted.artifacts.readable(admin,output.body.sha256));
  assert.deepEqual({scans,bytes},{scans:0,bytes:0});
  await kit.artifacts.revokeFindings(admin,source.body.sha256);
  const withdrawn=await counted.artifacts.source(admin,output.body.sha256,{record:output.digest});
  assert.equal(withdrawn?.bytes,null);
  assert.equal((await counted.artifacts.text(admin,output.body.sha256))?.readable,false);
  assert.equal((await counted.artifacts.readable(admin,output.body.sha256))?.digest,output.digest,'metadata remains visible after byte access is withdrawn');
  assert.deepEqual({scans,bytes},{scans:0,bytes:0});
});
test('public matcher methods and returned evidence cannot be altered to forge coverage', async t => {
  const {kit,admin,admitted}=await world(t); const first=fake(),second=fake();
  const a=await admitted(Buffer.from(line(first))),b=await admitted(Buffer.from(line(second)));
  const input=derived(Buffer.from(`immutable matcher\n${line(first)}`),[a.body.sha256,b.body.sha256]);
  const handle=await kit.artifacts.prepareDerived({origin:input.origin,author:input.author,derivedSources:input.derivedSources!});
  const result=handle.assess(input.bytes); assert.ok(result.derived);
  const bDecision=b.body.scan.accepted!;
  result.derived.sources[0]={sha256:b.body.sha256,record:b.digest,acceptances:[bDecision]};
  handle.assess=()=>result;
  await kit.artifacts.revokeFindings(admin,a.body.sha256);
  assert.equal((await kit.artifacts.ingest({...input,derivedCoverage:handle})).body.read_tier,'retain_only');
});
test('legacy tiers use an explicit compatibility default rather than treating admission tier as current authority', async t => {
  const {kit,admin}=await world(t);
  const held=await kit.artifacts.ingest(readInput(Buffer.from(line(fake()))));
  const body: SourceArtifactBody=structuredClone(held.body);delete body.requested_read_tier;
  const legacy=await kit.store.put({kind:'source_artifact',schema:'source_artifact@1',provenance:'observed',body,index:[{key:'artifact.sha256',value:body.sha256}]});
  const accepted=await kit.artifacts.acceptFindings(admin,body.sha256,'合成旧记录中的虚构示例');
  assert.equal(legacy.body.read_tier,'retain_only');
  assert.equal((await kit.artifacts.source(admin,body.sha256,{record:legacy.digest}))?.readTier,'model_readable');
  // An accepted/covered legacy record that was nevertheless retained proves an explicit retention request.
  const explicit=await kit.store.put({kind:'source_artifact',schema:'source_artifact@1',provenance:'observed',body:{...body,scan:{...body.scan,accepted:{by:admin.id,at:accepted.authorization.body.decided_at,authorization:accepted.authorization.digest}}},index:[{key:'artifact.sha256',value:body.sha256}]});
  assert.equal((await kit.artifacts.source(admin,body.sha256,{record:explicit.digest}))?.readTier,'retain_only');
});
test('admission snapshots caller-owned bytes before awaiting preparation of source coverage', async t => {
  const {kit,admitted}=await world(t); const first=fake(),second=fake();
  const source=await admitted(Buffer.from(line(second)));
  const bytes=Buffer.from(`mutable\n${line(first)}`), original=Buffer.from(bytes), changed=Buffer.from(`mutable\n${line(second)}`);
  assert.equal(bytes.length,changed.length);
  const prepare=kit.artifacts.prepareDerived.bind(kit.artifacts);
  t.mock.method(kit.artifacts,'prepareDerived',async (input: DerivedCoverageInput)=>{const handle=await prepare(input);bytes.set(changed);return handle;});
  const output=await kit.artifacts.ingest(derived(bytes,[source.body.sha256]));
  assert.equal(output.body.sha256,sha256Hex(original));
  assert.equal(output.body.read_tier,'retain_only');
  assert.deepEqual(Buffer.from((await kit.artifacts.trustedBytes(output.body.sha256))!),original);
});
