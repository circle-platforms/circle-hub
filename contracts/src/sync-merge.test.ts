// The exact same pure merge is available to both clients; fixture hashes are fixed protocol identities.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {mergePersonalSyncHeads} from './sync-merge.ts';
import {decodePersonalSyncObject} from './sync-canonical.ts';
const fixtures=JSON.parse(readFileSync(new URL('../test-fixtures/sync/v1/scenarios.json',import.meta.url),'utf8'));
test('shared merge vectors are independent of side, arrival order and client clocks',()=>{
 const nodes=new Map<string,{item_id:string;parents:string[]}>();for(const row of fixtures.objects){const value=decodePersonalSyncObject(Buffer.from(row.canonical),row.id);if('item_id'in value.body&&'parents'in value.body)nodes.set(row.id,{item_id:value.body.item_id,parents:value.body.parents});}
 for(const row of fixtures.merges){assert.deepEqual(mergePersonalSyncHeads(row.left,row.right,nodes),row.expected_heads,row.name);assert.deepEqual(mergePersonalSyncHeads([...row.right].reverse(),[...row.left].reverse(),nodes),row.expected_heads,row.name);}
});

test('shared native-link vectors preserve unknown filenames, readonly addresses, revision links and trailing text',()=>{
 const vectors=JSON.parse(readFileSync(new URL('../test-fixtures/sync/v1/native-links.json',import.meta.url),'utf8'));
 for(const row of vectors.cases){const value=decodePersonalSyncObject(Buffer.from(row.canonical),row.sha256);assert.deepEqual(value,row.input,row.name);}
});
