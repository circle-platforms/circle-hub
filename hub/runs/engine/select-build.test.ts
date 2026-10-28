import {createTestParserRegistry} from '../../testing/parsers.ts';
// The product pack's select_build function gets each candidate build with its single sources only: a role that lists
// external objects (thousands of case documents per build) is stripped before the sandbox call, so the input stays small
// whatever the knowledge base lists. A synthetic product pack whose function writes back, in its basis, which roles it saw.
// Temporary PostgreSQL and the real sandbox (skipped where sandbox-exec is missing, which is not a pass).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { KnownBuild } from '../../../contracts/src/product.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createRunsService } from './api.ts';
import { selectCandidate } from './target.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { FakeKnowledge, FakePacks } from './testing/knowledge.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { writePack } from './testing/packs.ts';

/** select_build that chooses the newest released candidate and says which source roles each candidate had (`[]` for a list). */
const ECHO = `export default function selectBuild(input: unknown): unknown {
  const { candidates } = input as { candidates: { name: string; released_at: string | null; sources: Record<string, unknown> }[] };
  const roles = candidates.map((c) => Object.keys(c.sources).sort().map((role) => (Array.isArray(c.sources[role]) ? role + '[]' : role)).join(','));
  const released = candidates.filter((c) => c.released_at !== null).sort((a, b) => String(b.released_at).localeCompare(String(a.released_at)));
  return { build: (released[0] ?? candidates[0]).name, basis: 'roles ' + roles.join(';') };
}
`;

/** Builds of the toy knowledge with a single role and a list role of many ids each. */
class ListingKnowledge extends FakeKnowledge {
  async builds(product: string, filter?: { line?: string; released?: boolean }): Promise<KnownBuild[]> {
    const builds = await super.builds(product, filter);
    return builds.map((b) => ({ ...b, sources: { tree: `toy:tree:${b.name}`, cases: Array.from({ length: 5000 }, (_, i) => `toy:case:${b.name}-${i}`) } }));
  }
}

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let h: Harness;
let dir: string;

before(async () => {
  postgres = await startPostgres();
  h = await openHarness(postgres);
  dir = await mkdtemp(join(tmpdir(), 'circle-hub-select-'));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('select_build candidates', () => {
  test('selectCandidate keeps the single sources and drops every role that is not one external object', () => {
    const build: KnownBuild = { name: 'b-1', family: 'Meadow', line: '3.2', base: 'b-1', platform: null, built_at: null, released_at: null, root: null, sources: { tree: 'toy:tree:b-1', cases: ['toy:case:1', 'toy:case:2'] } };
    assert.deepEqual(selectCandidate(build).sources, { tree: 'toy:tree:b-1' });
    assert.deepEqual(build.sources.cases, ['toy:case:1', 'toy:case:2'], 'the build itself is not changed');
    assert.deepEqual(selectCandidate({ ...build, sources: {} }).sources, {});
  });

  test('the function sees no list role, whatever the knowledge base lists for each build', { skip }, async () => {
    const meadow = h.packs.handles.find((handle) => handle.product.id === 'meadow')!;
    const echo = await writePack(dir, {
      id: 'meadow',
      version: '1.0.0',
      kind: 'product',
      title: meadow.product.title,
      description: '合成产品包（回显选构建的输入）',
      files: { 'product.json': { json: meadow.product }, 'functions/select-build.ts': ECHO },
    });
    const packs = new FakePacks();
    packs.handles.push(...h.packs.handles.map((handle) => (handle.product.id === 'meadow' ? { ...handle, directory: echo } : handle)));
    const service = createRunsService({ parsers:createTestParserRegistry(),records: h.kit, workflows: h.workflows, packs, knowledge: new ListingKnowledge(), external: h.external });
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    const answer = await service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } } }, h.call());
    assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
    const basis = answer.run!.target_basis.find((claim) => claim.statement.data?.field === 'build')!;
    assert.match(basis.statement.text, /^roles tree(;tree)*$/, `the candidates as the function saw them: ${basis.statement.text.slice(0, 200)}`);
    assert.equal(basis.qualifier.provenance, 'projected');
    assert.equal(answer.run!.build, 'Rel_PASTURE_3_2_9', 'the newest released candidate, chosen by the function');
  });
});
