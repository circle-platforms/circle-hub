import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRODUCER_KIND, type ReadTier } from '../../contracts/generated/vocabulary.ts';
import {
  UNAVAILABLE_MESSAGE,
  createDefaultRegistry,
  createDocumentCache,
  createParserRegistry,
  defaultParsers,
  fragmentDigest,
  kityminderParser,
  recordDigest,
  resolveReference,
  srcFragment,
  verifyQuote,
  type Parser,
  type ReaderIdentity,
  type RecordRead,
  type ResolveContext,
  type ResolveDiagnostic,
  type SourceRead,
  type TreeRead,
} from './api.ts';
import { fixture, sha256, utf8 } from './test-support.ts';

const alice: ReaderIdentity = { user: 'usr_01hzzzzzzzzzzzzzzzzzzzzzza', role: 'user' };
const bob: ReaderIdentity = { user: 'usr_01hzzzzzzzzzzzzzzzzzzzzzzb', role: 'user' };

type Stored = { bytes: Uint8Array; mediaType: string; readTier: ReadTier; owner: string };

function sources(stored: Stored[]): { reader: ResolveContext['sources']; reads: string[] } {
  const reads: string[] = [];
  const bySha = new Map(stored.map((item) => [sha256(item.bytes), item]));
  return {
    reads,
    reader: {
      read(digest, reader): SourceRead | null {
        reads.push(digest);
        const item = bySha.get(digest);
        if (!item || item.owner !== reader.user) return null;
        return { bytes: item.bytes, mediaType: item.mediaType, size: item.bytes.length, readTier: item.readTier };
      },
    },
  };
}

const map = fixture('mindmap.km.json');
const mapSha = sha256(map);
const spec = fixture('spec.md');
const specSha = sha256(spec);
const tree = fixture('command-tree.xml');
const treeSha = sha256(tree);
const secret = utf8('password = example-only\nline two\n');
const secretSha = sha256(secret);
const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
const binarySha = sha256(binary);

function context(extra: Partial<ResolveContext> = {}): { ctx: ResolveContext; diagnostics: ResolveDiagnostic[]; reads: string[] } {
  const diagnostics: ResolveDiagnostic[] = [];
  const store = sources([
    { bytes: map, mediaType: 'application/json', readTier: 'model_readable', owner: alice.user },
    { bytes: spec, mediaType: 'text/markdown', readTier: 'function_bytes_only', owner: alice.user },
    { bytes: tree, mediaType: 'application/xml', readTier: 'model_readable', owner: alice.user },
    { bytes: secret, mediaType: 'text/plain', readTier: 'retain_only', owner: alice.user },
    { bytes: binary, mediaType: 'image/png', readTier: 'model_readable', owner: alice.user },
  ]);
  const ctx: ResolveContext = { reader: alice, parsers: createDefaultRegistry(), sources: store.reader, onDiagnostic: (d) => diagnostics.push(d), ...extra };
  return { ctx, diagnostics, reads: store.reads };
}

const caseNode = JSON.parse(Buffer.from(map).toString('utf8')).root.children[0].children[2].children[1];

describe('resolveReference: source fragments', () => {
  it('resolves a mind-map node and checks a quotation against it', async () => {
    const { ctx } = context();
    const result = await resolveReference(srcFragment(mapSha, 'kityminder@1', ['n', caseNode.data.id]), ctx);
    assert.equal(result.resolved, true);
    if (!result.resolved) return;
    assert.equal(result.text, '创建池时名称超过 32 个字符被拒绝');
    assert.equal(result.readable, true);
    assert.equal(result.readTier, 'model_readable');
    assert.equal(result.mediaType, 'application/json');
    assert.equal(result.groundable, true);
    assert.equal(verifyQuote(result, '名称超过 32 个字符'), true);
    assert.equal(verifyQuote(result, '名称超过 33 个字符'), false);
  });

  it('answers with the canonical selector of the parser', async () => {
    const { ctx } = context();
    const byPosition = await resolveReference(srcFragment(treeSha, 'xml@1', 'i/0/0/0'), ctx);
    assert.ok(byPosition.resolved);
    assert.equal(byPosition.reference, srcFragment(treeSha, 'xml@1', 'x/commands/scope[1]/menu[1]/menu[1]'));
    const explicit = await resolveReference(srcFragment(treeSha, 'xml@1', 'x/commands[1]/scope[2]'), ctx);
    assert.ok(explicit.resolved);
    assert.equal(explicit.reference, srcFragment(treeSha, 'xml@1', 'x/commands/scope[2]'));
  });

  it('cuts byte ranges inside the fragment', async () => {
    const { ctx } = context();
    const reference = srcFragment(treeSha, 'xml@1', 'x/commands/scope[1]/menu[1]/menu[1]/item[1]/arguments/arg[1]/@help', [8, 17]);
    const result = await resolveReference(reference, ctx);
    assert.ok(result.resolved);
    assert.equal(result.text, 'the pool ');
    assert.equal(result.reference, reference);
    const outside = await resolveReference(srcFragment(treeSha, 'xml@1', 'x/commands/scope[1]/menu[1]/menu[1]/item[1]/arguments/arg[1]/@help', [0, 500]), ctx);
    assert.equal(outside.resolved, false);
    assert.equal(!outside.resolved && outside.code, 'REFERENCE_UNRESOLVED');
    const helpText = 'Name of the pool (café and naïve names are allowed)';
    const cafe = Buffer.byteLength(helpText.slice(0, helpText.indexOf('é')), 'utf8');
    const split = await resolveReference(srcFragment(treeSha, 'xml@1', 'x/commands/scope[1]/menu[1]/menu[1]/item[1]/arguments/arg[1]/@help', [0, cafe + 1]), ctx);
    assert.equal(split.resolved, false, 'a range that splits a character');
  });

  it('resolves whole files to their text, or to no text when binary', async () => {
    const { ctx } = context();
    const whole = await resolveReference(`src:${treeSha}`, ctx);
    assert.ok(whole.resolved && whole.readable, 'XML is decoded as xml@1 decodes it: the declaration says ISO-8859-1');
    assert.ok(whole.text!.includes('café and naïve') && whole.text!.startsWith('<?xml'));
    const png = await resolveReference(`src:${binarySha}`, ctx);
    assert.ok(png.resolved);
    assert.equal(png.text, null);
    assert.equal(png.readable, false);
    assert.equal(png.note, '二进制内容，没有文本');
    const mapWhole = await resolveReference(`src:${mapSha}`, ctx);
    assert.ok(mapWhole.resolved && mapWhole.text!.startsWith('{'));
  });

  it('reports unresolved selectors, unknown parsers, unparseable sources and bad syntax', async () => {
    const { ctx, reads } = context();
    const missing = await resolveReference(srcFragment(mapSha, 'kityminder@1', 'n/no-such-node'), ctx);
    assert.ok(!missing.resolved && missing.code === 'REFERENCE_UNRESOLVED' && /找不到/.test(missing.message));
    const before = reads.length;
    const unknown = await resolveReference(srcFragment(mapSha, 'xlsx@999', 'Service/7/C'), ctx);
    assert.ok(!unknown.resolved && unknown.code === 'REFERENCE_UNRESOLVED' && /没有登记/.test(unknown.message));
    assert.equal(reads.length, before, 'the parser is checked before the source is read');
    const wrongParser = await resolveReference(srcFragment(mapSha, 'xml@1', 'x/a'), ctx);
    assert.ok(!wrongParser.resolved && wrongParser.code === 'REFERENCE_UNRESOLVED' && /不能按 xml@1 解析/.test(wrongParser.message));
    const syntax = await resolveReference('src:xyz', ctx);
    assert.ok(!syntax.resolved && syntax.code === 'REFERENCE_UNRESOLVED' && syntax.reference === 'src:xyz' && /引用格式不对/.test(syntax.message));
    const external = await resolveReference('example:document:42', ctx);
    assert.ok(!external.resolved && external.code === 'REFERENCE_UNRESOLVED');
  });
});

describe('resolveReference: neutral permission answers and actionable read faults', () => {
  it('keeps absent and forbidden neutral while distinguishing integrity and reader faults', async () => {
    const { ctx, diagnostics } = context();
    const absent = srcFragment('e'.repeat(64), 'kityminder@1', 'n/x');
    const forbidden = srcFragment(mapSha, 'kityminder@1', 'n/x');
    const results = [
      await resolveReference(absent, ctx),
      await resolveReference(forbidden, { ...ctx, reader: bob }),
      await resolveReference(forbidden, {
        ...ctx,
        sources: { read: () => ({ bytes: utf8('tampered'), mediaType: 'application/json', size: 8, readTier: 'model_readable' }) },
      }),
      await resolveReference(forbidden, {
        ...ctx,
        sources: { read: () => ({ bytes: map, mediaType: 'application/json', size: map.length + 1, readTier: 'model_readable' }) },
      }),
      await resolveReference(forbidden, {
        ...ctx,
        sources: {
          read: () => {
            throw new Error('disk failure');
          },
        },
      }),
      await resolveReference(forbidden, { ...ctx, sources: undefined }),
    ];
    assert.deepEqual(results.map(result=>result.resolved?null:result.code),['SOURCE_UNAVAILABLE','SOURCE_UNAVAILABLE','SOURCE_INTEGRITY_UNPROVEN','SOURCE_INTEGRITY_UNPROVEN','SOURCE_RETRYABLE','SOURCE_RETRYABLE']);
    assert.deepEqual(results[0] && Object.keys(results[0]).sort(), ['code','fix','message','reference','resolved']);
    assert.equal(!results[1].resolved && results[1].message,UNAVAILABLE_MESSAGE);
    assert.ok(diagnostics.some((d) => /do not hash/.test(d.message)));
    assert.ok(diagnostics.some((d) => /disk failure/.test(d.message)));
    assert.ok(diagnostics.every((d) => !/对你不可用/.test(d.message)));
    // The internal caller still distinguishes unchecked work from a missing fragment (T03 R[3]).
    assert.deepEqual(
      results.map((result) => (result.resolved ? 'resolved' : (result.reason ?? null))),
      [null, null, 'integrity_unproven', 'integrity_unproven', 'check_error', 'check_error'],
    );
    const serialized = results.map(({ reference: _reference, ...rest }) => JSON.stringify(rest));
    assert.equal(serialized[0], serialized[1], 'absent and unauthorized remain identical');
    assert.ok(results.every((result) => !Object.keys(result).includes('reason') && !('reason' in { ...result })));
  });

  it('marks record and tree reader failures and tampered records as unchecked, not as absent', async () => {
    const { ctx } = context();
    const digest = 'd'.repeat(64);
    const failing = await resolveReference(`rec:${digest}`, { ...ctx, records: { read: () => Promise.reject(new Error('timeout')) } });
    assert.ok(!failing.resolved && failing.code === 'SOURCE_RETRYABLE' && failing.reason === 'check_error');
    const notJson = await resolveReference(`rec:${digest}`, { ...ctx, records: { read: () => ({ kind: 'claim', schema: 'claim@1', provenance: 'observed', created_at: '2026-10-21T08:00:00.000Z', body: { at: new Date(0) } }) } });
    assert.ok(!notJson.resolved && notJson.reason === 'integrity_unproven', 'a body that is not JSON data cannot be verified');
    const absent = await resolveReference(`rec:${digest}`, { ...ctx, records: { read: () => null } });
    assert.ok(!absent.resolved && absent.reason === undefined);
    const trees = { read: () => { throw new Error('db down'); }, readEntry: () => null };
    const tree = await resolveReference(`tree:${digest}/a`, { ...ctx, trees });
    assert.ok(!tree.resolved && tree.reason === 'check_error');
    const noTrees = await resolveReference(`entry:${digest}`, ctx);
    assert.ok(!noTrees.resolved && noTrees.reason === 'check_error');
  });
});

// The acceptance mutation check's M11: a quotation against a text the consumer may not read is not verified
// (null, an unknown), never true.
describe('verifyQuote on unreadable or missing text', () => {
  it('returns null when the text cannot be read, and false only when it can and differs', async () => {
    const { ctx } = context();
    const reference = srcFragment(specSha, 'markdown@1', ['b', '1', '概述', '功能说明', '超时']);
    const forModel = await resolveReference(reference, ctx);
    assert.ok(forModel.resolved && !forModel.readable && forModel.text === null, 'the model may not read this text');
    assert.equal(verifyQuote(forModel, '超时时间以秒计。设为 0 时配置被拒绝。'), null, 'unreadable: not verified, never true (M11)');
    const forFunction = await resolveReference(reference, { ...ctx, consumer: 'function' });
    assert.equal(verifyQuote(forFunction, '超时时间以秒计。设为 0 时配置被拒绝。'), true);
    assert.equal(verifyQuote(forFunction, '超时时间以秒计。设为 1 时配置被拒绝。'), false);
    const unresolved = await resolveReference(`src:${'0'.repeat(64)}`, ctx);
    assert.ok(!unresolved.resolved);
    assert.equal(verifyQuote(unresolved, '任何文字'), null);

    const visited = new Set<string>([reference]);
    const cyclic = await resolveReference(reference, { ...ctx, visited });
    assert.equal(cyclic.resolved, false);
    assert.equal(cyclic.message, `成环的引用：${reference}`);
  });
});

describe('resolveReference: read tiers', () => {
  it('gives a model only the structure of function-only sources, and a function the text', async () => {
    const { ctx } = context();
    const reference = srcFragment(specSha, 'markdown@1', ['b', '1', '概述', '功能说明', '超时']);
    const forModel = await resolveReference(reference, ctx);
    assert.ok(forModel.resolved);
    assert.equal(forModel.readable, false);
    assert.equal(forModel.text, null);
    assert.equal(forModel.fragment, null);
    assert.equal(forModel.note, '只许函数按引用读字节');
    assert.ok(forModel.summary);
    assert.ok(!JSON.stringify(forModel.summary).includes('超时时间'));
    assert.equal(verifyQuote(forModel, '超时'), null);
    const forFunction = await resolveReference(reference, { ...ctx, consumer: 'function' });
    assert.ok(forFunction.resolved && forFunction.readable);
    assert.equal(forFunction.text, '超时时间以秒计。设为 0 时配置被拒绝。');
    const forHuman = await resolveReference(reference, { ...ctx, consumer: 'human' });
    assert.ok(forHuman.resolved && !forHuman.readable);
  });

  it('never returns the original of retain-only sources', async () => {
    const { ctx } = context();
    for (const consumer of PRODUCER_KIND) {
      const result = await resolveReference(srcFragment(secretSha, 'text@1', 'l/1'), { ...ctx, consumer });
      assert.ok(result.resolved);
      assert.equal(result.readable, false);
      assert.equal(result.text, null);
      assert.equal(result.fragment, null);
      assert.equal(result.summary, null);
      assert.equal(result.note, '含凭据，原文不可读');
    }
  });

  it('gives retain-only sources one answer whatever the selector or range, so probing reveals nothing', async () => {
    const { ctx } = context();
    // Line 1 is 'password = example-only' (23 bytes): ranges and lines that exist and that do not must look the same.
    const probes = [
      srcFragment(secretSha, 'text@1', 'l/1'),
      srcFragment(secretSha, 'text@1', 'l/9'),
      srcFragment(secretSha, 'text@1', 'l/1', [0, 23]),
      srcFragment(secretSha, 'text@1', 'l/1', [0, 24]),
      srcFragment(secretSha, 'text@1', 'l/1', [3, 4]),
      srcFragment(secretSha, 'xml@1', 'i/0'),
      srcFragment(secretSha, 'markdown@1', 'h/password'),
    ];
    const answers = await Promise.all(probes.map((reference) => resolveReference(reference, ctx)));
    answers.forEach((answer, i) => {
      assert.ok(answer.resolved, probes[i]);
      assert.equal(answer.reference, probes[i], 'the reference comes back as given, never canonicalized by the parser');
    });
    const shapes = answers.map(({ reference: _reference, ...rest }) => JSON.stringify(rest));
    assert.equal(new Set(shapes).size, 1, 'every probe gets the same answer');
    const unknownParser = await resolveReference(srcFragment(secretSha, 'xlsx@999', 'a'), ctx);
    assert.ok(!unknownParser.resolved && unknownParser.code === 'REFERENCE_UNRESOLVED', 'an unregistered parser is refused for every source alike');
  });

  it('accepts a retain-only read without bytes, and treats missing bytes of any other tier as a failed read', async () => {
    const { ctx } = context();
    const withheld = { read: (): SourceRead => ({ bytes: null, mediaType: 'text/plain', size: secret.length, readTier: 'retain_only' }) };
    const answer = await resolveReference(srcFragment(secretSha, 'text@1', 'l/2'), { ...ctx, sources: withheld });
    assert.ok(answer.resolved && answer.note === '含凭据，原文不可读' && answer.text === null);
    const broken = { read: (): SourceRead => ({ bytes: null, mediaType: 'text/plain', size: secret.length, readTier: 'model_readable' }) };
    const failed = await resolveReference(srcFragment(secretSha, 'text@1', 'l/2'), { ...ctx, sources: broken });
    assert.ok(!failed.resolved && failed.code === 'SOURCE_INTEGRITY_UNPROVEN' && failed.reason === 'integrity_unproven');
  });
});

describe('resolveReference: knowledge tree and records', () => {
  const root = 'a'.repeat(64);
  const entry = 'b'.repeat(64);
  const grounds = [srcFragment(treeSha, 'xml@1', 'x/commands/scope[1]/menu[1]')];
  const trees: ResolveContext['trees'] = {
    read(r, path, e, reader): TreeRead | null {
      if (r !== root || reader.user !== alice.user) return null;
      if (path === '/commands/widget' && (e === null || e === entry)) return { text: 'widget: Widget management', mediaType: 'text/plain', readTier: 'model_readable', grounds };
      return null;
    },
    readEntry(e, reader): TreeRead | null {
      return e === entry && reader.user === alice.user ? { text: 'widget: Widget management', mediaType: null, readTier: 'model_readable', grounds } : null;
    },
  };

  it('resolves tree nodes with the source fragments that warrant them', async () => {
    const { ctx } = context({ trees });
    const node = await resolveReference(`tree:${root}/commands/widget`, ctx);
    assert.ok(node.resolved);
    assert.equal(node.text, 'widget: Widget management');
    assert.deepEqual(node.grounds, grounds);
    assert.equal(node.groundable, true);
    const pinned = await resolveReference(`tree:${root}/commands/widget@${entry}`, ctx);
    assert.ok(pinned.resolved);
    const alone = await resolveReference(`entry:${entry}`, ctx);
    assert.ok(alone.resolved);
    assert.equal(alone.groundable, false, 'an entry cannot stand alone as grounds');
    const other = await resolveReference(`tree:${root}/commands/widget`, { ...ctx, reader: bob });
    assert.ok(!other.resolved && other.code === 'SOURCE_UNAVAILABLE');
    const none = await resolveReference(`tree:${root}/commands/widget`, { ...ctx, trees: undefined });
    assert.ok(!none.resolved && none.code === 'SOURCE_RETRYABLE');
  });

  it('answers a path that a visible root does not have as unresolved, and an invisible root as unavailable', async () => {
    const withRoots: ResolveContext['trees'] = { ...trees!, hasRoot: (r, reader) => r === root && reader.user === alice.user };
    const { ctx } = context({ trees: withRoots });
    const typo = await resolveReference(`tree:${root}/commands/widgte`, ctx);
    assert.ok(!typo.resolved && typo.code === 'REFERENCE_UNRESOLVED' && /没有这个路径/.test(typo.message), 'a typo in a visible root gets a usable fix');
    const wrongEntry = await resolveReference(`tree:${root}/commands/widget@${'c'.repeat(64)}`, ctx);
    assert.ok(!wrongEntry.resolved && wrongEntry.code === 'REFERENCE_UNRESOLVED');
    const foreign = await resolveReference(`tree:${root}/commands/widgte`, { ...ctx, reader: bob });
    assert.ok(!foreign.resolved && foreign.code === 'SOURCE_UNAVAILABLE', 'a root the reader may not see stays neutral');
    const otherRoot = await resolveReference(`tree:${'e'.repeat(64)}/commands/widget`, ctx);
    assert.ok(!otherRoot.resolved && otherRoot.code === 'SOURCE_UNAVAILABLE');
    const without = await resolveReference(`tree:${root}/commands/widgte`, context({ trees }).ctx);
    assert.ok(!without.resolved && without.code === 'SOURCE_UNAVAILABLE', 'a reader without hasRoot keeps the neutral answer');
    const failing = await resolveReference(`tree:${root}/commands/widgte`, context({ trees: { ...trees!, hasRoot: () => Promise.reject(new Error('down')) } }).ctx);
    assert.ok(!failing.resolved && failing.reason === 'check_error');
  });

  it('drops grounds a tree reader returns in a non-canonical form', async () => {
    const sloppy: ResolveContext['trees'] = {
      read: () => ({ text: 'x', mediaType: null, readTier: 'model_readable', grounds: [grounds[0], ` ${grounds[0]}`, 'not a reference'] }),
      readEntry: () => null,
    };
    const { ctx, diagnostics } = context({ trees: sloppy });
    const node = await resolveReference(`tree:${root}/commands/widget`, ctx);
    assert.ok(node.resolved);
    assert.deepEqual(node.grounds, grounds);
    assert.equal(diagnostics.filter((d) => /not a canonical reference/.test(d.message)).length, 2);
  });

  const claim: RecordRead = {
    kind: 'claim',
    schema: 'claim@1',
    provenance: 'observed',
    created_at: '2026-10-21T08:00:00.000Z',
    body: { statement: { text: '命令存在' }, grounds: [], validity: { status: 'valid', bound: [], premises: [] } },
  };
  const result: RecordRead = {
    kind: 'validation_result',
    schema: 'validation@1',
    provenance: 'observed',
    created_at: '2026-10-21T08:00:01.000Z',
    body: { items: [{ item: 'doc:n1', requirements: [{ claims: [{ statement: { text: '不通过' }, validity: { status: 'expired' } }] }] }], counts: { delivered: 1 } },
  };
  const log: RecordRead = { kind: 'call_log', schema: 'call_log@1', provenance: 'observed', created_at: '2026-10-21T08:00:02.000Z', body: { tool: 'get_nodes' } };
  const stored = new Map([claim, result, log].map((record) => [recordDigest(record), record]));
  const records: ResolveContext['records'] = { read: (digest, reader) => (reader.user === alice.user ? (stored.get(digest) ?? null) : null) };

  it('re-verifies record digests and follows JSON Pointers', async () => {
    const { ctx } = context({ records });
    const whole = await resolveReference(`rec:${recordDigest(claim)}`, ctx);
    assert.ok(whole.resolved);
    assert.equal(whole.recordKind, 'claim');
    assert.equal(whole.groundable, true);
    assert.deepEqual(whole.validity, { status: 'valid', bound: [], premises: [] });
    const text = await resolveReference(`rec:${recordDigest(claim)}#/statement/text`, ctx);
    assert.ok(text.resolved);
    assert.equal(text.text, '命令存在');
    assert.deepEqual(text.validity, { status: 'valid', bound: [], premises: [] }, 'the enclosing claim gives the validity');
    const nested = await resolveReference(`rec:${recordDigest(result)}#/items/0/requirements/0/claims/0/statement`, ctx);
    assert.ok(nested.resolved);
    assert.equal(nested.text, '{"text":"不通过"}');
    assert.deepEqual(nested.validity, { status: 'expired' });
    const counts = await resolveReference(`rec:${recordDigest(result)}#/counts/delivered`, ctx);
    assert.ok(counts.resolved && counts.text === '1');
    const missing = await resolveReference(`rec:${recordDigest(result)}#/items/1`, ctx);
    assert.ok(!missing.resolved && missing.code === 'REFERENCE_UNRESOLVED');
    const callLog = await resolveReference(`rec:${recordDigest(log)}`, ctx);
    assert.ok(callLog.resolved && callLog.groundable === false, 'call logs are not grounds');
  });

  it('treats a tampered or foreign record as unavailable', async () => {
    const { ctx, diagnostics } = context({ records });
    const digest = recordDigest(claim);
    const tampered = await resolveReference(`rec:${digest}`, { ...ctx, records: { read: () => ({ ...claim, body: { ...(claim.body as object), extra: 1 } }) } });
    assert.ok(!tampered.resolved && tampered.code === 'SOURCE_INTEGRITY_UNPROVEN');
    assert.ok(diagnostics.some((d) => /hashes to/.test(d.message)));
    const foreign = await resolveReference(`rec:${digest}`, { ...ctx, reader: bob });
    assert.ok(!foreign.resolved && foreign.code === 'SOURCE_UNAVAILABLE');
  });
});

describe('resolveReference: canonical selectors that cannot be written', () => {
  it('resolves a mind-map root whose id is too long to cite by its position, never rejecting', async () => {
    const bytes = utf8(JSON.stringify({ root: { data: { id: 'k'.repeat(9000), text: '根' }, children: [{ data: { id: 'c', text: '子' } }] } }));
    const sha = sha256(bytes);
    const store = { read: (): SourceRead => ({ bytes, mediaType: 'application/json', size: bytes.length, readTier: 'model_readable' }) };
    const { ctx } = context({ sources: store });
    const root = await resolveReference(`src:${sha}/kityminder@1/i`, ctx);
    assert.ok(root.resolved);
    assert.equal(root.reference, `src:${sha}/kityminder@1/i`);
    assert.equal(root.text, '根');
    const child = await resolveReference(`src:${sha}/kityminder@1/i/0`, ctx);
    assert.ok(child.resolved && child.reference === `src:${sha}/kityminder@1/n/c`);
    assert.equal(kityminderParser.parse(bytes).model.nodes[0].selector, 'i');
  });

  it('turns a parser answer that cannot be written into an unresolved result instead of a rejection', async () => {
    const bad: Parser = {
      ...defaultParsers()[5],
      id: 'loose',
      parse: (bytes) => ({ parser: 'loose@1', model: null, locate: () => ({ selector: 'x'.repeat(9000), text: Buffer.from(bytes).toString(), byteRange: null }), listSelectors: () => [], summary: () => ({}) }),
    };
    const bytes = utf8('anything');
    const { ctx } = context({ parsers: createParserRegistry([bad]), sources: { read: () => ({ bytes, mediaType: 'text/plain', size: bytes.length, readTier: 'model_readable' }) } });
    const result = await resolveReference(srcFragment(sha256(bytes), 'loose@1', 'a'), ctx);
    assert.ok(!result.resolved && result.code === 'REFERENCE_UNRESOLVED');
  });
});

describe('document cache and fragment digests', () => {
  it('parses a source once for repeated references', async () => {
    let parses = 0;
    const registry = createDefaultRegistry();
    const counting = registry.get('kityminder@1')!;
    const wrapped = createDefaultRegistry();
    const parsers = {
      ...wrapped,
      get: (key: string) => (key === 'kityminder@1' ? { ...counting, parse: (bytes: Uint8Array, options?: object) => (parses++, counting.parse(bytes, options)) } : wrapped.get(key)),
    };
    const { ctx } = context({ parsers, documents: createDocumentCache(4) });
    for (const node of caseNode.children) await resolveReference(srcFragment(mapSha, 'kityminder@1', ['n', node.data.id]), ctx);
    await resolveReference(srcFragment(mapSha, 'kityminder@1', ['n', caseNode.data.id]), ctx);
    assert.equal(parses, 1);
  });

  it('digests fragment text', () => {
    assert.equal(fragmentDigest({ text: 'abc' }), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('resolveReference: the validity of a record claim (B01 R[3])', () => {
  const recordOf = (validity: Record<string, unknown>) => ({ kind: 'claim', schema: 'claim@1', provenance: 'observed', created_at: '2026-10-21T08:00:00.000Z', body: { at: '1970-01-01T00:00:00.000Z', validity } });

  it('re-reads expires_at against the injected clock: the same record expires or not as the clock moves', async () => {
    const record = recordOf({ status: 'valid', bound: [], expires_at: '2030-01-01T00:00:00.000Z', premises: [] }) as unknown as RecordRead;
    const digest = recordDigest(record);
    const at = (extra: Partial<ResolveContext>): { validity: { status: string } } => {
      void extra;
      return {} as { validity: { status: string } };
    };
    void at;
    const before = await resolveReference(`rec:${digest}`, { ...context({ records: { read: () => record }, now: () => new Date('2029-12-31T23:59:59.000Z') }).ctx });
    assert.equal(((before as unknown as { validity: { status: string } }).validity).status, 'valid', 'the injected clock is before the expiry');
    const after = await resolveReference(`rec:${digest}`, { ...context({ records: { read: () => record }, now: () => new Date('2030-01-02T00:00:00.000Z') }).ctx });
    assert.equal(((after as unknown as { validity: { status: string } }).validity).status, 'expired', 'the injected clock is past the expiry');
  });
});
