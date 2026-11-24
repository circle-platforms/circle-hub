import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kityminderParser } from '../../../skill/mindmap-format/api.ts';
import { fixtureText } from '../../../../tests/fixtures/recompose/index.ts';
import projectRecompose from '../recompose/functions/project.ts';
import { PRODUCT, ROOT, fixture } from './recompose.ts';

type Row = { [key: string]: any };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export const FROZEN_RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';

export function syntheticMindMap(): { bytes: string; sha256: string } {
  const pass = JSON.parse(fixtureText('author-pass.km.json'));
  const other = JSON.parse(fixtureText('author-underdetermined.km.json'));
  const bytes = JSON.stringify({ root: { data: { id: 'part-root', text: 'ORBIT / COMET synthetic parts' }, children: [pass.root.children[0], other.root.children[0]] } });
  return { bytes, sha256: sha(bytes) };
}

export function knowledgeNodes(root: string, run: string, entries: readonly Row[]): string {
  const nodes = new Map<string, Row>();
  const node = (path: string): Row => {
    let found = nodes.get(path);
    if (found === undefined) {
      found = { path, reference: `tree:${root}${path === '/' ? '/' : path}`, name: path.split('/').at(-1) ?? '', level: 'trunk', digest: sha('node ' + path), children: [], entries: [] };
      nodes.set(path, found);
    }
    return found;
  };
  node('/');
  node('/commands');
  node('/').children.push({ name: 'commands', path: '/commands', digest: sha('node /commands') });
  for (const entry of entries) {
    let path = '/commands';
    for (const word of entry.words as string[]) {
      const next = `${path}/${word}`;
      const parent = node(path);
      if (!nodes.has(next)) parent.children.push({ name: word, path: next, digest: sha('node ' + next) });
      path = next;
      node(next);
    }
    const at = node(path);
    at.level = 'leaf';
    const digest = sha('entry ' + (entry.words as string[]).join(' ') + JSON.stringify(entry.signatures));
    at.entries.push({ entry: digest, kind: 'definition', statement: (entry.words as string[]).join(' '), reference: `tree:${root}${path}@${digest}`, data: { words: entry.words, signatures: entry.signatures, ...(entry.summary !== undefined ? { summary: entry.summary } : {}) } });
  }
  const rows = [...nodes.values()];
  const head = { schema: 'run-knowledge@1', run, root, composition: null, nodes: rows.length, entries: rows.reduce((sum, row) => sum + row.entries.length, 0) };
  return [head, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
}

export interface FrozenRunFixture {
  run: Row;
  items: Row[];
  root: string;
  nodes: string;
  catalogEntries: Row[];
}

export function frozenRunFixture(overrides: Row = {}): FrozenRunFixture {
  const map = syntheticMindMap();
  const parsed = kityminderParser.parse(Buffer.from(map.bytes), {});
  const projected = projectRecompose({ inputs: [{ slot: 'subject', parser: 'kityminder@1', model: parsed.model, sha256: map.sha256 }], parameters: { case_depths: [1] }, context: { run: FROZEN_RUN, predecessor: null } } as any);
  const items = (projected.items ?? []).map((item) => ({ ...item, digest: sha('item ' + item.id) }));
  const catalogEntries = fixture().catalog.entries as Row[];
  const run: Row = {
    run: FROZEN_RUN,
    pack: 'recompose@1.2.8',
    pack_digest: sha('synthetic pack digest'),
    product: 'orbit',
    version: '10.8',
    build: 'Rel_ORBIT_10_8_0_30',
    root: ROOT,
    product_pack_digest: PRODUCT,
    parameters: { case_depths: [1] },
    groups: projected.groups,
    target_basis: [],
    items,
    sources: [{ slot: 'subject', role: 'subject', reference: 'src:' + map.sha256, label: 'synthetic.km.json', media_type: 'application/json' }],
    ...overrides,
  };
  return { run, items, root: ROOT, nodes: knowledgeNodes(ROOT, FROZEN_RUN, catalogEntries), catalogEntries };
}

export async function writeFrozenRun(dir: string, frozen: FrozenRunFixture = frozenRunFixture()): Promise<FrozenRunFixture> {
  await mkdir(join(dir, 'knowledge'), { recursive: true });
  await writeFile(join(dir, 'run.json'), JSON.stringify(frozen.run));
  await writeFile(join(dir, 'knowledge', 'nodes.jsonl'), frozen.nodes);
  return frozen;
}
