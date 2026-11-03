// completeKnowledgeView names the grammar mistake of an id the reader refused, and only then.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort } from '../ports.ts';
import { completeKnowledgeView } from './complete-view.ts';

const context = { principal: { id: 'usr_synthetic', name: 'synthetic', role: 'user' }, run: null, purpose: 'synthetic binding' } as unknown as ExternalReadContext;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** A reader that refuses every id except the ones given, which it answers with a stub page that is no public view. */
function reader(known: string[]) {
  const bytes = new Map<string, Uint8Array>();
  const external = {
    read: async (id: string): Promise<ExternalRead> => {
      if (!known.includes(id)) return { ok: false, id, reason: `no synthetic page ${id}` };
      const hash = sha(id);
      bytes.set(hash, new TextEncoder().encode(JSON.stringify({ schema: 'stub-page@1' })));
      return { ok: true, id, revision: 'r1', artifacts: [{ name: 'content', artifact: { digest: `d${hash}`, body: { sha256: hash } } }] } as unknown as ExternalRead;
    },
  } as unknown as ExternalReaderPort;
  const records = { artifacts: { source: async (_principal: unknown, hash: string) => ({ bytes: bytes.get(hash), sha256: hash }) }, store: {} } as any;
  return (id: string) => completeKnowledgeView(id, context, external, records);
}

test('an empty only the reader refused is named with the way to write the id, not left as a bare refusal', async () => {
  const read = await reader([])('knowledge:index:acme:Rel_ACME_1?kind=case&key=document&only=&fields=document,node');
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.match(read.inputError?.message ?? '', /知识视图标识写错了：only 要列 1 到/);
  assert.match(read.inputError?.fix ?? '', /knowledge:<视图>:<产品>:<构建>/);
});

test('a well-formed id the reader refused stays the plain refusal the caller may not see behind', async () => {
  const read = await reader([])('knowledge:index:acme:Rel_ACME_1?kind=case&key=document&only=1001');
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.inputError, undefined);
});

test('an id only a stub reader knows is still read', async () => {
  const id = 'knowledge:index:acme:Rel_ACME_1?kind=case&key=document&only=';
  const read = await reader([id])(id);
  assert.equal(read.ok, true);
});
