// The fragments of an adoc production (task kb-adoc item 5): each entry cites a chapter file of the group by its digest
// and a text@1 line selector, in the shape the Hub's own verifyFragment accepts — not K1's markdown@1 key and not a
// whole `src:` reference packed into the selector. The check runs the Hub's verifier over every produced fragment
// against a text@1 parse of the file it names. Synthetic adoc only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { textParser } from '../../../../../hub/refs/api.ts';
import { verifyFragment, type FragmentSources } from '../../../../../hub/knowledge/verify.ts';
import type { ParsedSource, SourceLoader } from '../../../../../hub/knowledge/sources.ts';
import { compileAdoc } from './index.ts';
import { toK1Model } from './k1-model.ts';
import { ADOC_PARSER, produceAdocEntries } from './entries.ts';

const FILES: Record<string, string> = {
  'book.adoc': '= Synthetic\n\ninclude::pool.adoc[]\n\ninclude::route.adoc[]\n',
  'pool.adoc': ['== 成员池', '', '本节介绍成员池的配置。', '', '成员池最多 32 个成员。', ''].join('\n'),
  'route.adoc': ['== 静态路由', '', '本节介绍静态路由的配置。', '', '删除路由前先保存配置。', ''].join('\n'),
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const compile = async (files: Record<string, string>) => {
  const out = await compileAdoc({
    main: 'book.adoc',
    revision: '42',
    attributes: {},
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: sha(text) }])),
  });
  assert.ok(out.ok, JSON.stringify(out));
  return out;
};

/** The group's chapter files as the Hub would hold them: parsed with text@1, keyed by digest, in one list slot. */
const sourcesOf = (files: Record<string, string>): { sources: FragmentSources; bySha: Map<string, string> } => {
  const elements = new Map<string, ParsedSource>();
  const bySha = new Map<string, string>();
  for (const [file, text] of Object.entries(files)) {
    const sha256 = sha(text);
    bySha.set(sha256, file);
    // verifyFragment reads the digest, the parser and the parsed document of a source; the record fields around them
    // belong to the read that produced it and are not part of this check.
    elements.set(sha256, { sha256, parser: ADOC_PARSER, document: textParser.parse(new TextEncoder().encode(text)) } as unknown as ParsedSource);
  }
  return { sources: { single: new Map(), list: { slot: 'manual', elements } }, bySha };
};

// A fragment's parser is decided by the source it names, so the loader is never asked for another parse.
const loader = { documentWith: () => null } as unknown as SourceLoader;

test('every produced fragment is a text@1 line of the chapter file it names, and the Hub verifies it', async () => {
  const out = await compile(FILES);
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.ok(produced.entries.length > 0);
  const { sources, bySha } = sourcesOf(FILES);
  for (const entry of produced.entries) {
    assert.ok(entry.fragments.length > 0, JSON.stringify(entry));
    for (const fragment of entry.fragments) {
      assert.equal(fragment.parser, ADOC_PARSER, JSON.stringify(fragment));
      assert.equal(fragment.slot, 'manual');
      assert.match(fragment.selector, /^l\/[1-9][0-9]*(?:-[1-9][0-9]*)?$/, JSON.stringify(fragment));
      assert.equal(fragment.range, undefined, 'a line of the original is cited whole; no byte range inside a mapped text');
      const file = bySha.get(fragment.source ?? '');
      assert.ok(file !== undefined, `${JSON.stringify(fragment)} names no file of the group`);
      const verified = verifyFragment(fragment, sources, loader);
      assert.ok(verified.ok, `${JSON.stringify(fragment)}: ${verified.ok ? '' : verified.reason}`);
      // The line the fragment cites holds the entry's own words: the citation is not merely well formed.
      const located = sources.list!.elements.get(fragment.source!)!.document.locate(fragment.selector);
      assert.ok(located !== null);
      const statement = String(entry.statement);
      assert.ok(
        located!.text.split('\n').some((line) => line.includes(statement) || statement.includes(line)),
        `${JSON.stringify(fragment)} cites ${JSON.stringify(located!.text)} for ${JSON.stringify(statement)}`,
      );
    }
  }
});

test('the two families cite the same chapter files, and a fragment of the other family is not citable in this batch', async () => {
  const out = await compile(FILES);
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  const { sources } = sourcesOf(FILES);
  const fragment = produced.entries[0]!.fragments[0]!;
  // Another file's digest is not an element of this batch: the Hub refuses it, so an entry cannot cite another group.
  const foreign = { ...fragment, source: sha('not a chapter of this group') };
  const refused = verifyFragment(foreign, sources, loader);
  assert.equal(refused.ok, false);
});

test('the shape K1 emits without the rewrite is refused by the Hub: a packed reference is not a selector', async () => {
  const out = await compile(FILES);
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  const { sources } = sourcesOf(FILES);
  const cite = mapped.model.blocks.find((block) => block.text === '本节介绍成员池的配置。')!.cite;
  const packed = { slot: 'manual', source: cite.sha256, parser: 'markdown@1', selector: `src:${cite.sha256}/text@1/${cite.selector}` };
  const refused = verifyFragment(packed, sources, loader);
  assert.equal(refused.ok, false, 'the packed spelling must not verify');
  const plain = { slot: 'manual', source: cite.sha256, parser: ADOC_PARSER, selector: cite.selector };
  assert.ok(verifyFragment(plain, sources, loader).ok, 'the same citation in its own fields verifies');
});

test('a fragment the mapping cannot resolve refuses the group instead of going out as a reference to nothing', async () => {
  const out = await compile(FILES);
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  // Constructed: a block whose citation is dropped after the mapping, which is what an unmapped selector would mean.
  const broken = structuredClone(mapped);
  const target = broken.model.blocks.find((block) => block.text === '删除路由前先保存配置。');
  assert.ok(target !== undefined);
  target.cite = { file: 'route.adoc', sha256: '', selector: 'l/5' };
  const produced = produceAdocEntries(broken, { name: 'cli-famx', slot: 'manual' });
  assert.equal(produced.ok, false);
  if (!produced.ok) {
    assert.equal(produced.error.code, 'famx.adoc.fragment_not_cited');
    assert.notEqual(produced.error.next_action, '');
    assert.equal('entries' in produced, false);
  }
});

const COMMAND_FILES: Record<string, string> = {
  'book.adoc': '= Synthetic\n\ninclude::commands.adoc[]\n',
  'commands.adoc': [
    '== 配置命令',                              // 1
    '',                                        // 2
    '[cols="2,3",options="header"]',            // 3
    '|===',                                     // 4
    '| 命令 | 说明',                             // 5
    '| *demo pool add* _<name>_ | 添加成员',     // 6
    '| *demo pool del* _<name>_ | 删除成员',     // 7
    '|===',                                     // 8
    '',                                        // 9
  ].join('\n'),
};

/** The Hub's own check over every fragment of every entry, against a text@1 parse of the file each fragment names. */
const checkFragments = (entries: Array<{ statement: string; fragments: Array<{ slot?: string; source?: string; parser: string; selector: string; range?: [number, number] }> }>, files: Record<string, string>): void => {
  const { sources, bySha } = sourcesOf(files);
  for (const entry of entries) {
    assert.ok(entry.fragments.length > 0, JSON.stringify(entry));
    for (const fragment of entry.fragments) {
      assert.equal(fragment.parser, ADOC_PARSER, JSON.stringify(fragment));
      assert.equal(fragment.slot, 'manual');
      assert.match(fragment.selector, /^l\/[1-9][0-9]*(?:-[1-9][0-9]*)?$/, JSON.stringify(fragment));
      assert.ok(bySha.has(fragment.source ?? ''), `${JSON.stringify(fragment)} names no file of the group`);
      const verified = verifyFragment(fragment as never, sources, loader);
      assert.ok(verified.ok, `${entry.statement} ${JSON.stringify(fragment)}: ${verified.ok ? '' : verified.reason}`);
    }
  }
};

test('every row of a command table cites its own source line, not the header line of the table', async () => {
  const out = await compile(COMMAND_FILES);
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  const digest = sha(COMMAND_FILES['commands.adoc']!);
  assert.deepEqual(produced.entries.filter(entry=>entry.data.form==='signature'),[]);
  const signatures = produced.entries.filter((entry) => entry.data.form === 'table_row'&&entry.statement.includes('成员'));
  assert.deepEqual(
    signatures.map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.source, entry.fragments[0]!.selector]),
    [
      ['| **demo pool add** *<name>* | 添加成员 |', '/manual/cli-famx/配置命令', digest, 'l/6'],
      ['| **demo pool del** *<name>* | 删除成员 |', '/manual/cli-famx/配置命令', digest, 'l/7'],
    ],
    JSON.stringify(signatures.map((entry) => [entry.statement, entry.fragments])),
  );
  // The row's own text cites the same line, and no entry cites a byte range inside a mapped table text.
  const described = produced.entries.filter((entry) => String(entry.statement).includes('成员'));
  assert.deepEqual(described.map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]), [
    ['| **demo pool add** *<name>* | 添加成员 |', '/manual/cli-famx/配置命令', 'l/6'],
    ['| **demo pool del** *<name>* | 删除成员 |', '/manual/cli-famx/配置命令', 'l/7'],
  ]);
  checkFragments(produced.entries, COMMAND_FILES);
});

test('a table row whose cells were not verified is reported and does not borrow another row\'s line', async () => {
  const out = await compile(COMMAND_FILES);
  const model = structuredClone(out.model);
  const table = model.blocks.find((block) => block.rows !== undefined);
  assert.ok(table !== undefined && table.rows !== undefined);
  // Constructed: the second body row loses the verification of its cells.
  for (const cell of table.rows.body[1]!) cell.origins = [];
  const mapped = toK1Model(model, out.composition, 'cli-famx');
  assert.ok(
    mapped.uncited.some((one) => one.kind === 'table' && one.file === 'commands.adoc' && one.reason.includes('没有已核对的单元格')),
    JSON.stringify(mapped.uncited),
  );
  assert.ok(mapped.model.blocks.every((block) => !block.text.includes('删除成员')), 'the uncited row stays out of the mapped text');
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.ok(produced.entries.every((entry) => !String(entry.statement).includes('删除成员')));
  assert.ok(produced.warnings.some((warning) => warning.includes('回核不到原文行')), produced.warnings.join('；'));
  // What stays is cited on its own line: the surviving row does not move onto the dropped row's line or the header's.
  const kept = produced.entries.filter((entry) => entry.data.form === 'table_row'&&entry.statement.includes('添加成员'));
  assert.deepEqual(kept.map((entry) => [String(entry.statement), entry.fragments[0]!.selector]), [['| **demo pool add** *<name>* | 添加成员 |', 'l/6']]);
  checkFragments(produced.entries, COMMAND_FILES);
});
