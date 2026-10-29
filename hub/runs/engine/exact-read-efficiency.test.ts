import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocumentCache, createParserRegistry, type ParsedDocument, type Parser } from '../../refs/api.ts';
import { sha256Hex } from '../../records/api.ts';
import { createResolver, type RunScope } from './exact.ts';
import type { EngineContext } from './deps.ts';

function fixture() {
  const bytes = Buffer.from('synthetic document');
  const sha = sha256Hex(bytes);
  let reads = 0, readable = true, batches = 0, singles = 0;
  const loaded = new Set<string>();
  const document: ParsedDocument = {
    parser: 'synthetic@1', model: {}, summary: () => ({}), listSelectors: () => [],
    async prefetch(selectors) { batches++; for (const selector of selectors) loaded.add(selector); },
    async locate(selector) { if (!loaded.has(selector)) singles++; return { selector, text: 'synthetic text', byteRange: null }; },
  };
  const parser: Parser = { id: 'synthetic', version: 1, mediaTypes: ['text/plain'], limits: { maxBytes: 1000, maxDepth: 2, maxNodes: 100 }, parse: () => document };
  const ctx = { deps: { records: { artifacts: { source: async () => { reads++; return readable ? { bytes, size: bytes.length, mediaType: 'text/plain', readTier: 'model_readable' } : null; } }, store: {} }, knowledge: { treeReader: () => ({}) } }, parsers: createParserRegistry([parser]), documents: createDocumentCache(), log: () => {} } as unknown as EngineContext;
  const scope: RunScope = { reader: { user: 'synthetic', role: 'user' }, sources: new Map([[sha, 'subject']]), records: new Map(), subject: { shas: new Set([sha]), records: new Set() }, root: null, catalogs: [], candidates: async () => [] };
  const references = Array.from({ length: 40 }, (_, n) => `src:${sha}/synthetic@1/l/${n + 1}`);
  return { resolver: createResolver(ctx, scope, 'model'), references, stats: () => ({ reads, batches, singles }), setReadable: (value: boolean) => { readable = value; } };
}

test('one document with forty quotations avoids a redundant read per prefetched selector', async () => {
  const f = fixture();
  await f.resolver.prefetch(f.references);
  assert.deepEqual(f.stats(), { reads: 81, batches: 1, singles: 0 });
  for (const reference of f.references) assert.equal((await f.resolver.resolve(reference)).ok, true);
  assert.equal(f.stats().reads, 121, 'each actual use still checks current access');
});

test('the prefetched result is not disclosed when access changes before use', async () => {
  const f = fixture();
  await f.resolver.prefetch(f.references);
  f.setReadable(false);
  assert.equal((await f.resolver.resolve(f.references[0])).ok, false);
  f.setReadable(true);
  assert.equal((await f.resolver.resolve(f.references[0])).ok, true);
});
