// The impact view filtered to a catalog (catalog=<id>): only the catalog's members count as changes, read per root like
// read.ts catalog() (the kind and producer from the product's declaration for that root), compared by syntax — the
// catalog-entry@1 descriptive fields (parameter descriptions, the entry summary), the per-root references and the
// signature ids are out, and overloads compare as a set. A root without the catalog is a refusal with the reason, not
// an empty answer; changed may be omitted (the catalog's kind) or must equal it. Synthetic roots, two producers of
// definition entries on the same paths: the command tree (the catalog's producer) and a handbook (another producer).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ImpactView } from '../../contracts/src/views.ts';
import type { ExternalRead, ExternalReadContext } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { createKnowledgeReader } from './api.ts';
import { parseViewId } from './views.ts';
import { makeWorld, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

// Producer of catalog-shaped definition entries from the <group> elements of a synthetic catalog XML: one entry per
// command, one signature per <sig>, parameter attributes min/max/def/opt/desc mapping to the catalog-entry@1 fields.
const CAT_SOURCE = `
function elements(node) { return node.children.filter((c) => typeof c === 'object' && c !== null); }
function paramsOf(sig) {
  return elements(sig).filter((p) => p.name === 'param').map((p) => {
    const type = p.attributes.type;
    const out = { name: p.attributes.name, type: type === 'int' || type === 'keyword' ? type : 'string' };
    if (p.attributes.min !== undefined) out.minimum = Number(p.attributes.min);
    if (p.attributes.max !== undefined) out.maximum = Number(p.attributes.max);
    if (p.attributes.def !== undefined) out.default = p.attributes.def;
    if (p.attributes.opt === 'yes') out.optional = true;
    if (p.attributes.desc !== undefined) out.description = p.attributes.desc;
    return out;
  });
}
export default function produce(input) {
  const slot = input.slots.tree;
  if (slot === null) return { entries: [], warnings: ['没有命令树'] };
  const entries = [];
  for (const group of elements(slot.model.root)) {
    if (group.name !== 'group') continue;
    for (const command of elements(group)) {
      if (command.name !== 'command') continue;
      const words = [group.attributes.name, ...String(command.attributes.name).split(' ')];
      const signatures = elements(command).filter((s) => s.name === 'sig').map((sig, i) => ({ id: String(i + 1), params: paramsOf(sig) }));
      entries.push({
        kind: 'definition',
        path: '/commands/' + words.join('/'),
        statement: words.join(' '),
        data: { words, signatures, ...(command.attributes.help ? { summary: command.attributes.help } : {}) },
        fragments: [{ parser: 'xml@1', selector: 'x/catalog' }],
        applicability: null,
      });
    }
  }
  return { entries, warnings: [] };
}
`;

// A second producer over the <book> elements of the same XML: catalog-shaped definition entries on the same paths, so
// only the declaration's producer filter keeps them out of the catalog. The edition text sits in the statement and a
// parameter description, so two editions give different digests with the same syntax.
const BOOK_SOURCE = `
function elements(node) { return node.children.filter((c) => typeof c === 'object' && c !== null); }
export default function produce(input) {
  const slot = input.slots.tree;
  if (slot === null) return { entries: [], warnings: ['没有命令树'] };
  const entries = [];
  for (const book of elements(slot.model.root)) {
    if (book.name !== 'book') continue;
    const edition = String(book.attributes.edition ?? '0');
    for (const command of elements(book)) {
      if (command.name !== 'command') continue;
      const words = [book.attributes.name, ...String(command.attributes.name).split(' ')];
      entries.push({
        kind: 'definition',
        path: '/commands/' + words.join('/'),
        statement: '手册 ' + edition + ' ' + words.join(' '),
        data: { words, signatures: [{ id: '1', params: [{ name: 'note', type: 'string', description: '手册第' + edition + '版' }] }], summary: '手册签名' },
        fragments: [{ parser: 'xml@1', selector: 'x/catalog' }],
        applicability: null,
      });
    }
  }
  return { entries, warnings: [] };
}
`;

const xml = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?><catalog>${inner}</catalog>`;
const group = (name: string, commands: string): string => `<group name="${name}">${commands}</group>`;
const book = (name: string, edition: number, commands: string): string => `<book name="${name}" edition="${edition}">${commands}</book>`;
const command = (name: string, sigs: string, help?: string): string => `<command name="${name}"${help === undefined ? '' : ` help="${help}"`}>${sigs}</command>`;
const sig = (params: string): string => `<sig>${params}</sig>`;

interface Fixture {
  w: World;
  roots: { a: string; b: string };
  /** Entry digest by statement's first line, per root. */
  digests: { a: Map<string, string>; b: Map<string, string> };
  read(id: string): Promise<ExternalRead>;
  json(read: ExternalRead): Promise<unknown>;
}

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  builds: { a: string; b: string },
  options: { catalogs?: unknown[] } = {},
): Promise<Fixture> {
  const w = await makeWorld(postgres, {
    pack: {
      declaration: {
        producers: [
          { id: 'commands', title: '命令树', function: { module: 'functions/cat.ts' }, inputs: { tree: { source: 'tree' } } },
          { id: 'book', title: '手册', function: { module: 'functions/book.ts' }, inputs: { tree: { source: 'tree' } } },
        ],
        catalogs: options.catalogs ?? [{ id: 'commands@1', entry_kind: 'definition', producer: 'commands', complete: true, case_sensitive: false }],
      },
      functions: { 'cat.ts': CAT_SOURCE, 'book.ts': BOOK_SOURCE },
    },
  });
  t.after(() => w.close());
  const produce = async (name: string, source: string): Promise<string> => {
    w.external.set(`site:tree:${name}`, { bytes: source, mediaType: 'application/xml' });
    const built = await w.knowledge.produceTree({
      product: w.product,
      build: { name, family: 'ACME', line: '1.2', base: name, platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: null, sources: { tree: `site:tree:${name}` }, root: null },
    });
    assert.equal(built.ok, true, built.reason ?? '');
    return built.root as string;
  };
  const a = await produce('Rel_ACME_1_2_15', builds.a);
  const b = await produce('Rel_ACME_1_2_16', builds.b);
  const digestsOf = async (root: string): Promise<Map<string, string>> => {
    const page = await w.knowledge.getNodes({ root, paths: ['/'], depth: 6 }, w.admin);
    const out = new Map<string, string>();
    for (const node of page?.nodes ?? []) for (const entry of node.entries) out.set(entry.statement.split('\n')[0], entry.entry);
    return out;
  };
  const reader = createKnowledgeReader(w.knowledge);
  const context = (principal: Principal): ExternalReadContext => ({ principal, run: null, purpose: '目录视图测试' });
  return {
    w,
    roots: { a, b },
    digests: { a: await digestsOf(a), b: await digestsOf(b) },
    read: (id) => reader.read(id, context(w.user)),
    async json(read) {
      assert.equal(read.ok, true, read.ok ? '' : read.reason);
      if (!read.ok) throw new Error('not ok');
      const original = read.artifacts.find((x) => x.name === 'original');
      assert.ok(original);
      const source = await w.kit.artifacts.source(w.user, original.artifact.body.sha256, { consumer: 'function' });
      assert.ok(source !== null && source.bytes !== null);
      return JSON.parse(new TextDecoder().decode(source.bytes));
    },
  };
}

const A = 'Rel_ACME_1_2_15';
const B = 'Rel_ACME_1_2_16';
/** The impact id with the catalog, attached kinds emptied to keep the notes to the catalog ones. */
const impactId = (extra = ''): string => `knowledge:impact:acme:${A}..${B}?catalog=commands@1&attached=${extra}`;
/** The same pair without the catalog parameter. */
const plainId = `knowledge:impact:acme:${A}..${B}?changed=definition&attached=`;

describe('影响视图按目录比（catalog=commands@1）', () => {
  test('另一个生产器在同一路径上的不同定义不算变更（跨版本线的手册差异消失）', async (t) => {
    const groups =
      group('system', command('reboot', sig('<param name="delay" type="int" min="0" max="600" desc="延迟秒数"/>'), '重启设备')) +
      group('net', command('ping', sig('<param name="host" type="string" desc="主机"/>'), '发送探测'));
    const f = await fixture(t, {
      a: xml(groups + book('system', 1, command('reboot', sig(''))) + book('net', 1, command('ping', sig('')))),
      b: xml(groups + book('system', 2, command('reboot', sig(''))) + book('net', 2, command('ping', sig('')))),
    });
    const view = ImpactView.parse(await f.json(await f.read(impactId())));
    assert.equal(view.catalog, 'commands@1');
    assert.deepEqual(view.changed_kinds, ['definition'], 'changed 不写时取目录的成员种类');
    assert.deepEqual(view.changes, []);
    assert.deepEqual(view.totals, { changed_paths: 0, attached_from: 0, attached_to: 0 });
    assert.deepEqual(view.notes, ['这条产品线还没有不分版本的根；下一步：同步这条产品线']);
    // 不按目录时，手册的两处差异是两处“修改”。
    const plain = ImpactView.parse(await f.json(await f.read(plainId)));
    assert.deepEqual(
      plain.changes.map((c) => [c.path, c.change]),
      [
        ['/commands/net/ping', 'modified'],
        ['/commands/system/reboot', 'modified'],
      ],
    );
  });

  test('只改参数说明和条目摘要不另算变更，notes 里计数', async (t) => {
    const f = await fixture(t, {
      a: xml(
        group('system', command('reboot', sig('<param name="delay" type="int" min="0" max="600" desc="延迟秒数"/>'), '重启设备')) +
          group('net', command('ping', sig('<param name="host" type="string" desc="主机"/>'), '发送探测')),
      ),
      b: xml(
        group('system', command('reboot', sig('<param name="delay" type="int" min="0" max="600" desc="等待的秒数"/>'), '重启设备')) +
          group('net', command('ping', sig('<param name="host" type="string" desc="主机"/>'), '发出探测')),
      ),
    });
    const view = ImpactView.parse(await f.json(await f.read(impactId())));
    assert.deepEqual(view.changes, []);
    assert.equal(view.totals.changed_paths, 0);
    assert.deepEqual(view.notes, ['2 个路径的目录成员只有说明性内容（参数说明、条目摘要）或签名顺序的差异，不算变更', '这条产品线还没有不分版本的根；下一步：同步这条产品线']);
  });

  test('改默认值、加可选参数、改取值范围算修改', async (t) => {
    const f = await fixture(t, {
      a: xml(
        group('system', command('reboot', sig('<param name="delay" type="int" min="0" max="600"/>')) + command('show', sig(''), '查看状态')) +
          group('net', command('ping', sig('<param name="host" type="string"/>'))),
      ),
      b: xml(
        group('system', command('reboot', sig('<param name="delay" type="int" min="0" max="900" def="30"/>')) + command('show', sig(''), '查看状态')) +
          group('net', command('ping', sig('<param name="host" type="string"/><param name="count" type="int" opt="yes" def="3" desc="次数"/>'))),
      ),
    });
    const view = ImpactView.parse(await f.json(await f.read(impactId())));
    const def = (m: Map<string, string>, words: string) => m.get(words) as string;
    assert.deepEqual(view.changes, [
      { path: '/commands/net/ping', change: 'modified', before: [def(f.digests.a, 'net ping')], after: [def(f.digests.b, 'net ping')] },
      { path: '/commands/system/reboot', change: 'modified', before: [def(f.digests.a, 'system reboot')], after: [def(f.digests.b, 'system reboot')] },
    ]);
    assert.notEqual(def(f.digests.a, 'system reboot'), def(f.digests.b, 'system reboot'));
    assert.equal(view.totals.changed_paths, 2);
    assert.deepEqual(view.notes, ['这条产品线还没有不分版本的根；下一步：同步这条产品线']);
    // before、after 仍是条目摘要，引用照旧能解析。
    assert.equal(view.entries[def(f.digests.a, 'system reboot')].reference, `tree:${f.roots.a}/commands/system/reboot@${def(f.digests.a, 'system reboot')}`);
    assert.equal(view.entries[def(f.digests.b, 'net ping')].reference, `tree:${f.roots.b}/commands/net/ping@${def(f.digests.b, 'net ping')}`);
  });

  test('命令从目录里删除、另一个生产器在那条路径上还有定义：算删除', async (t) => {
    const books = book('net', 1, command('ping', sig('')) + command('trace', sig('')));
    const f = await fixture(t, {
      a: xml(group('net', command('ping', sig('<param name="host" type="string"/>')) + command('trace', sig('<param name="host" type="string"/>'))) + books),
      b: xml(group('net', command('ping', sig('<param name="host" type="string"/>'))) + books),
    });
    const view = ImpactView.parse(await f.json(await f.read(impactId())));
    assert.deepEqual(view.changes, [{ path: '/commands/net/trace', change: 'removed', before: [f.digests.a.get('net trace') as string], after: [] }]);
    assert.deepEqual(view.notes, ['这条产品线还没有不分版本的根；下一步：同步这条产品线']);
    // 不按目录时，手册还在那条路径上，于是被算成“修改”而不是“删除”。
    const plain = ImpactView.parse(await f.json(await f.read(plainId)));
    assert.deepEqual(
      plain.changes.map((c) => [c.path, c.change]),
      [['/commands/net/trace', 'modified']],
    );
  });

  test('重载换了顺序不算变更', async (t) => {
    const two = sig('<param name="delay" type="int"/>') + sig('<param name="delay" type="int"/><param name="force" type="keyword"/>');
    const swapped = sig('<param name="delay" type="int"/><param name="force" type="keyword"/>') + sig('<param name="delay" type="int"/>');
    const f = await fixture(t, {
      a: xml(group('system', command('reboot', two))),
      b: xml(group('system', command('reboot', swapped))),
    });
    const view = ImpactView.parse(await f.json(await f.read(impactId())));
    assert.deepEqual(view.changes, []);
    assert.deepEqual(view.notes, ['1 个路径的目录成员只有说明性内容（参数说明、条目摘要）或签名顺序的差异，不算变更', '这条产品线还没有不分版本的根；下一步：同步这条产品线']);
  });

  test('同一版本线：手册相同，按目录比和不按目录比给出同一组路径', async (t) => {
    const books = book('system', 1, command('reboot', sig('')));
    const f = await fixture(t, {
      a: xml(group('system', command('reboot', sig('<param name="delay" type="int" min="0" max="600"/>'), '重启设备')) + books),
      b: xml(group('system', command('reboot', sig('<param name="delay" type="int" min="0" max="900"/>'), '重启设备')) + books),
    });
    const view = ImpactView.parse(await f.json(await f.read(impactId())));
    const plain = ImpactView.parse(await f.json(await f.read(plainId)));
    assert.deepEqual(
      view.changes.map((c) => [c.path, c.change]),
      [['/commands/system/reboot', 'modified']],
    );
    assert.deepEqual(
      plain.changes.map((c) => [c.path, c.change]),
      view.changes.map((c) => [c.path, c.change]),
    );
  });

  test('changed 写了目录之外的种类：拒绝并写明原因', async (t) => {
    const f = await fixture(t, { a: xml(group('system', command('reboot', sig('')))), b: xml(group('system', command('reboot', sig('')))) });
    const explicit = await f.read(impactId('&changed=definition'));
    assert.equal(explicit.ok, true, explicit.ok ? '' : explicit.reason);
    for (const [changed, written] of [
      ['behaviour', 'behaviour'],
      ['definition,behaviour', 'behaviour、definition'],
    ]) {
      const read = await f.read(impactId(`&changed=${changed}`));
      assert.equal(read.ok, false);
      assert.equal(!read.ok && read.reason, `带了目录 commands@1 时 changed 只能不写或写 definition（目录的成员种类），写了 ${written}`);
    }
  });

  test('某个根没有目录声明：视图不回答，原因写明哪个根', async (t) => {
    const f = await fixture(
      t,
      { a: xml(group('system', command('reboot', sig('')))), b: xml(group('system', command('reboot', sig('')))) },
      { catalogs: [] },
    );
    const read = await f.read(impactId());
    assert.equal(read.ok, false);
    assert.equal(!read.ok && read.reason, `构建 ${A} 的根没有目录 commands@1，算不出目录成员的变化`);
  });
});

describe('视图标识里的 catalog 参数', () => {
  test('字面 commands@1 和百分号转义的 commands%401 都解析到同一个目录', () => {
    for (const written of ['commands@1', 'commands%401']) {
      const parsed = parseViewId(`knowledge:impact:acme:${A}..${B}?catalog=${written}&attached=`);
      assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason);
      if (parsed.ok && parsed.value.type === 'impact') {
        assert.equal(parsed.value.catalog, 'commands@1');
        assert.deepEqual(parsed.value.changed, []);
        assert.equal(parsed.value.revision, null);
      } else {
        assert.fail('不是影响视图');
      }
    }
  });

  test('目录参数和修订共存：修订照样认出', () => {
    const from = '0'.repeat(64);
    const to = '1'.repeat(64);
    const parsed = parseViewId(`knowledge:impact:acme:${A}..${B}?catalog=commands@1&attached=@${from}..${to}`);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason);
    if (parsed.ok && parsed.value.type === 'impact') {
      assert.equal(parsed.value.catalog, 'commands@1');
      assert.equal(parsed.value.revision, `${from}..${to}`);
    } else {
      assert.fail('不是影响视图');
    }
  });

  test('目录名的写法、重复和不属于这个视图的参数都被拒绝', () => {
    const bad = (id: string): string => {
      const parsed = parseViewId(id);
      assert.equal(parsed.ok, false, id);
      return parsed.ok ? '' : parsed.reason;
    };
    assert.match(bad(`knowledge:impact:acme:${A}..${B}?catalog=commands`), /目录 .* 的写法不对/);
    assert.match(bad(`knowledge:impact:acme:${A}..${B}?catalog=commands@1&catalog=commands@1`), /参数 catalog 写了两次/);
    assert.match(bad(`knowledge:impact:acme:${A}..${B}?catalog=`), /参数 catalog 只能有一个取值/);
    assert.match(bad(`knowledge:facets:acme:${B}?kind=case&by=line&catalog=commands@1`), /视图 facets 不认识参数 catalog/);
    // 没有目录时 changed 仍至少要有一个种类；有目录时不写 changed 用目录的种类。
    assert.match(bad(`knowledge:impact:acme:${A}..${B}?changed=&attached=`), /changed 至少要有一个条目种类/);
    const parsed = parseViewId(`knowledge:impact:acme:${A}..${B}?catalog=commands@1&changed=&attached=`);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason);
  });
});
