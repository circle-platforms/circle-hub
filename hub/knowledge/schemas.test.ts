// The record shapes this package registers in contracts/src/knowledge.ts: each is in SCHEMA_REGISTRY, its published JSON
// Schema compiles in the MCP SDK's validator without a warning, accepts what zod accepts and refuses an unknown key.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { SCHEMA_REGISTRY } from '../../contracts/src/index.ts';
import { schemas } from '../../contracts/src/knowledge.ts';

type JsonSchema = Parameters<AjvJsonSchemaValidator['getValidator']>[0];
const H = (c: string): string => c.repeat(64);
const build = { name: 'b1', family: 'ACME', line: '1.2', base: 'b1', platform: null, built_at: null, released_at: '2026-01-05T00:00:00.000Z', sources: { tree: 'site:tree:b1' } };

const EXAMPLES: Record<string, unknown> = {
  'tree_node@1': { name: 'net', height: 1, level: 'branch', children: [{ name: 'ping', digest: H('1') }], entries: [H('2')] },
  'knowledge-entry@1': { product: 'acme', kind: 'definition', statement: 'net ping', data: { words: ['net', 'ping'] }, applicability: null },
  'tree_root@1': {
    product: 'acme',
    version: { line: '1.2', build: 'b1', family: 'ACME', platform: null },
    build,
    root: H('3'),
    producer: { pack: 'acme', version: '1.0.0', digest: H('4'), id: 'acme@1.0.0', producers: [{ id: 'commands', function: { module: 'functions/commands.ts' } }] },
    sources: [
      { producer: 'commands', slot: 'tree', external: 'site:tree:b1', revision: null, sha256: H('5'), size: 10, media_type: 'application/xml', parser: 'xml@1', artifact: H('6'), read_tier: 'model_readable', basis: 'release_record', decided_by: 'acme@1.0.0' },
    ],
    composition: [
      { path: '/commands/net/ping', entry: H('2'), kind: 'definition', producers: ['commands', 'manual'], fragments: [`src:${H('5')}/xml@1/x/catalog/group[2]/command[1]`], basis: 'release_record', decided_by: 'acme@1.0.0' },
    ],
    unplaced: [
      { entry: H('7'), kind: 'definition', producers: ['manual'], section: 'Ping', fragments: [`src:${H('8')}/markdown@1/b/0/Manual`], basis: 'declared', decided_by: 'acme@1.0.0', stopped_at: '/', candidate: { path: '/commands', model: 'jev-1.13.0', p: 0.8, calibrated: false }, judgments: [H('9')], note: '本链尚未校准' },
    ],
    refused: [{ producer: 'commands', index: 4, unplaced: false, kind: '', path: '/commands/ghost', reason: '找不到' }],
    refused_count: 1,
    catalogs: [{ id: 'catalog@1', entry_kind: 'definition', producer: 'commands', complete: false, case_sensitive: false, declared_complete: true, members: 1, incomplete_reason: '1 个条目没有通过核对' }],
    counts: { nodes: 4, entries: 1, placed_by_model: 0, unplaced: 1 },
    warnings: [],
    warnings_count: 0,
    produced_at: '2026-01-06T00:00:00.000Z',
  },
  'root_pointer@1': { product: 'acme', line: '1.2', pointer: 'knowledge/acme/1.2', expected: null, root: H('3'), build: 'b1', composition: H('a'), move: H('b'), version: 1, cause: `rec:${H('c')}` },
  'knowledge-build@1': { product: 'acme', build, pack: { id: 'acme', version: '1.0.0', digest: H('4') }, plan: null, sync: 'sync_01jacd5z8q3w7v9h2k4m6n8p0t' },
  'knowledge-calibration@1': { kind: 'placement.choice', model: 'jev-1.13.0', origin: 'declared', samples: [{ input: H('d'), expected: 'net', chosen: 'net', probability: 0.97 }], decided_by: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t', root: null, note: null },
  'knowledge-observation@1': { product: 'acme', build: 'b1', device: 'unit-1', collected_at: '2026-02-01T08:00:00.000Z', echo: H('e'), declared_by: 'review@1.0.0' },
  'knowledge-candidate@1': {
    owner: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t',
    product: 'acme',
    root: H('3'),
    path: '/commands/net/ping',
    cited_fragment: H('f'),
    statement: 'ping 发回显请求',
    ground: { reference: `src:${H('1')}`, quote: 'echo' },
    applicability: null,
  },
};

const generated = new URL('../../contracts/generated/schemas/', import.meta.url);
const published = (id: string): JsonSchema => {
  const [name, major] = id.split('@');
  return JSON.parse(readFileSync(new URL(`${name}.v${major}.schema.json`, generated), 'utf8')) as JsonSchema;
};

test('every shape of the package is registered and has an example here', () => {
  assert.deepEqual(Object.keys(schemas).sort(), Object.keys(EXAMPLES).sort());
  for (const id of Object.keys(schemas)) assert.equal(SCHEMA_REGISTRY[id], schemas[id], id);
});

test('stored kinds are entry kinds, levels are node levels and the producers of a row are sorted and unique', () => {
  const entry = EXAMPLES['knowledge-entry@1'] as Record<string, unknown>;
  for (const kind of ['command', '', 'k'.repeat(201)]) assert.equal(schemas['knowledge-entry@1'].safeParse({ ...entry, kind }).success, false, kind.slice(0, 10));
  for (const kind of ['definition', 'behaviour', 'case', 'defect', 'observation']) assert.equal(schemas['knowledge-entry@1'].safeParse({ ...entry, kind }).success, true, kind);
  assert.equal(schemas['tree_node@1'].safeParse({ ...(EXAMPLES['tree_node@1'] as object), level: '枝' }).success, false);
  for (const producers of [['manual', 'commands'], ['commands', 'commands'], [], ['Commands']]) {
    const root = structuredClone(EXAMPLES['tree_root@1']) as { composition: Array<Record<string, unknown>>; unplaced: Array<Record<string, unknown>> };
    root.composition[0].producers = producers;
    assert.equal(schemas['tree_root@1'].safeParse(root).success, false, producers.join(','));
    root.composition[0].producers = ['commands'];
    root.unplaced[0].producers = producers;
    assert.equal(schemas['tree_root@1'].safeParse(root).success, false, producers.join(','));
  }
});

test('the published schemas compile without a warning, accept what zod accepts and refuse an unknown key', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  try {
    const ajv = new AjvJsonSchemaValidator();
    for (const [id, body] of Object.entries(EXAMPLES)) {
      const check = ajv.getValidator(published(id));
      assert.equal(schemas[id].safeParse(structuredClone(body)).success, true, `zod accepts the ${id} example`);
      const result = check(structuredClone(body));
      assert.ok(result.valid, `${id}: ${result.errorMessage}`);
      const extra = { ...(body as Record<string, unknown>), surplus: 1 };
      assert.equal(schemas[id].safeParse(extra).success, false, `zod refuses an unknown key in ${id}`);
      assert.equal(check(extra).valid, false, `the published ${id} refuses an unknown key`);
    }
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
});
