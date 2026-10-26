// The section paths of the mapped model (task kb-adoc item 4): they follow K1 and have the same shape as markdown@1's —
// the segment is the heading's own source text (attributes expanded, character references decoded, inline marks off),
// repeated sibling keys are numbered `[k]` from 1, and the selector is the encoded `h/` path. Sections are keyed by the
// node the engine gave for them, so two sections with the same title stay two sections and `IPv4/IPv6` is not the parent
// of `IPv4` and `IPv6`. A title is never read as a signature (task item 6). Synthetic adoc only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { compileAdoc } from './index.ts';
import { toK1Model } from './k1-model.ts';
import { produceAdocEntries } from './entries.ts';

const compile = async (files: Record<string, string>, attributes: Record<string, string | boolean> = {}) => {
  const out = await compileAdoc({
    main: 'book.adoc',
    revision: '42',
    attributes,
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: createHash('sha256').update(text).digest('hex') }])),
  });
  assert.ok(out.ok, JSON.stringify(out));
  return out;
};

const place = async (files: Record<string, string>, attributes: Record<string, string | boolean> = {}, name = 'cli') => {
  const out = await compile(files, attributes);
  const mapped = toK1Model(out.model, out.composition, name);
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name, slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  return { mapped, produced };
};

test('a section path is the heading source text, with no tag, no character reference and no inline mark', async () => {
  const { mapped, produced } = await place({
    'book.adoc': [
      '= Synthetic',                 // 1
      '',                            // 2
      '== `demo pool` 命令',          // 3
      '',                            // 4
      '甲。',                         // 5
      '',                            // 6
      "== Don't panic -- 保持",        // 7
      '',                            // 8
      '乙。',                         // 9
      '',                            // 10
      '== *配置* _成员池_',            // 11
      '',                            // 12
      '丙。',                         // 13
      '',                            // 14
    ].join('\n'),
  });
  assert.deepEqual(
    mapped.model.sections.slice(1).map((section) => [section.title, section.key, section.ordinal, section.selector]),
    [
      ['demo pool 命令', 'demo pool 命令', 1, 'h/demo%20pool%20命令'],
      ["Don't panic -- 保持", "Don't panic -- 保持", 1, "h/Don't%20panic%20--%20保持"],
      ['配置 成员池', '配置 成员池', 1, 'h/配置%20成员池'],
    ],
    JSON.stringify(mapped.model.sections.slice(1)),
  );
  assert.deepEqual(
    produced.entries.map((entry) => [String(entry.statement), entry.path]),
    [
      ['甲。', '/manual/cli/demo%20pool%20命令'],
      ['乙。', "/manual/cli/Don't%20panic%20--%20保持"],
      ['丙。', '/manual/cli/配置%20成员池'],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.path, entry.data])),
  );
  // A title is no signature, whatever its spelling: the marked heading above placed no command.
  assert.deepEqual(produced.entries.filter((entry) => entry.data.form === 'signature'), []);
  assert.ok(produced.entries.every((entry) => String(entry.path).startsWith('/manual/cli/')), JSON.stringify(produced.entries.map((entry) => entry.path)));
});

test('repeated sibling titles are numbered as markdown@1 numbers them, and each section keeps its own blocks', async () => {
  const { mapped, produced } = await place({
    'book.adoc': [
      '= Synthetic',          // 1
      '',                     // 2
      '== 命令',               // 3
      '',                     // 4
      '*demo pool add* _<name>_', // 5
      '',                     // 6
      '第一节的正文。',          // 7
      '',                     // 8
      '== 命令',               // 9
      '',                     // 10
      '第二节的正文。',          // 11
      '',                     // 12
      '=== 命令',              // 13
      '',                     // 14
      '子节的正文。',            // 15
      '',                     // 16
      '== 示例[2]',            // 17
      '',                     // 18
      '一个以序号结尾的标题。',   // 19
      '',                     // 20
    ].join('\n'),
  });
  assert.deepEqual(
    mapped.model.sections.slice(1).map((section) => [section.title, section.ordinal, section.selector]),
    [
      ['命令', 1, 'h/命令'],
      ['命令', 2, 'h/命令[2]'],
      ['命令', 1, 'h/命令[2]/命令'],
      ['示例[2]', 1, 'h/示例[2][1]'],
    ],
    JSON.stringify(mapped.model.sections.slice(1)),
  );
  const paths = produced.entries.map((entry) => [String(entry.statement), entry.path, entry.data.form]);
  assert.deepEqual(paths, [
    ['**demo pool add** *<name>*', '/manual/cli/命令', 'text'],
    ['第一节的正文。', '/manual/cli/命令', 'text'],
    ['第二节的正文。', '/manual/cli/命令[2]', 'text'],
    ['子节的正文。', '/manual/cli/命令[2]/命令', 'text'],
    ['一个以序号结尾的标题。', '/manual/cli/示例[2][1]', 'text'],
  ], JSON.stringify(paths));
  assert.equal(new Set(mapped.model.sections.map((section) => section.selector)).size, mapped.model.sections.length, 'every section selector is its own');
});

test('a slash in a title is one segment, so IPv4/IPv6 is not the parent of IPv4 and IPv6', async () => {
  const { produced } = await place({
    'book.adoc': [
      '= Synthetic',   // 1
      '',              // 2
      '== IPv4/IPv6',  // 3
      '',              // 4
      '甲。',           // 5
      '',              // 6
      '== IPv4',       // 7
      '',              // 8
      '=== IPv6',      // 9
      '',              // 10
      '乙。',           // 11
      '',              // 12
    ].join('\n'),
  });
  assert.deepEqual(
    produced.entries.map((entry) => [String(entry.statement), entry.path]),
    [
      ['甲。', '/manual/cli/IPv4%2FIPv6'],
      ['乙。', '/manual/cli/IPv4/IPv6'],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.path])),
  );
});

test('a heading attribute reference carries each family\'s own value into the section path', async () => {
  const files = { 'book.adoc': '= Synthetic\n\n== {product} 概述\n\n正文。\n' };
  const famx = await place(files, { product: 'FAMX' }, 'cli-famx');
  const famy = await place(files, { product: 'FAMY' }, 'cli-famy');
  assert.equal(famx.produced.entries[0]!.path, '/manual/cli-famx/FAMX%20概述');
  assert.equal(famy.produced.entries[0]!.path, '/manual/cli-famy/FAMY%20概述');
  assert.equal(famx.mapped.model.sections[1]!.title, 'FAMX 概述');
  // Both cite the same source line, which still holds the placeholder.
  assert.equal(famx.mapped.model.sections[1]!.cite?.selector, 'l/3');
  assert.equal(famy.mapped.model.sections[1]!.cite?.selector, 'l/3');
});

test('a heading that verifies on no source line still gives a path, and the mapping says the title came from the engine', async () => {
  const out = await compile({ 'book.adoc': '= Synthetic\n\n== 说明\n\n甲。\n' });
  const model = structuredClone(out.model);
  // Constructed: the heading line of the second section is not verified, so no source text is left for its segment.
  const section = model.blocks.find((block) => block.kind === 'section' && block.title === '说明');
  const content = model.blocks.find((block) => block.kind === 'paragraph');
  assert.ok(section !== undefined && content !== undefined);
  section.origins = [];
  section.origin = null;
  section.heading = null;
  // The section's own path element and the one its blocks carry are the same object before the clone; both are changed.
  section.path = section.path.map((one) => ({ ...one, title: '<code>demo pool</code> 命令' }));
  content.path = content.path.map((one) => ({ ...one, title: '<code>demo pool</code> 命令' }));
  const mapped = toK1Model(model, out.composition, 'cli');
  assert.equal(mapped.model.sections[1]!.title, 'demo pool 命令', 'the fallback is the engine title with its tags off');
  assert.equal(mapped.model.sections[1]!.selector, 'h/demo%20pool%20命令');
  assert.equal(mapped.model.sections[1]!.cite, null, 'a heading with no verified line cites nothing');
  assert.ok(mapped.warnings.some((warning) => warning.includes('章节标题回核不到源行')), mapped.warnings.join('；'));
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.equal(produced.entries[0]!.path, '/manual/cli/demo%20pool%20命令');
});

test('an empty section and a section whose content is all uncited still take their ordinal', async () => {
  const files = {
    'book.adoc': [
      '= Synthetic',      // 1
      '',                 // 2
      '== 示例',           // 3
      '',                 // 4
      '== 示例',           // 5
      '',                 // 6
      '第二节正文。',       // 7
      '',                 // 8
    ].join('\n'),
  };
  const withContent = {
    'book.adoc': [
      '= Synthetic',      // 1
      '',                 // 2
      '== 示例',           // 3
      '',                 // 4
      '第一节的正文。',     // 5
      '',                 // 6
      '== 示例',           // 7
      '',                 // 8
      '第二节正文。',       // 9
      '',                 // 10
    ].join('\n'),
  };
  // The first section is empty: markdown@1 numbers every heading, so the second is 示例[2] and its prose hangs there.
  const empty = await place(files);
  assert.deepEqual(
    empty.mapped.model.sections.slice(1).map((section) => [section.title, section.ordinal, section.selector]),
    [['示例', 1, 'h/示例'], ['示例', 2, 'h/示例[2]']],
    JSON.stringify(empty.mapped.model.sections),
  );
  assert.deepEqual(empty.produced.entries.map((entry) => [String(entry.statement), entry.path]), [['第二节正文。', '/manual/cli/示例[2]']]);

  // The same, with the first section holding a block that cites nothing: its path must not move to the second section,
  // and the second section's ordinal must not depend on whether an unrelated block verifies.
  const out = await compile(withContent);
  const model = structuredClone(out.model);
  const first = model.blocks.find((block) => block.kind === 'paragraph');
  assert.ok(first !== undefined && first.raw === '第一节的正文。');
  first.origins = [];
  first.origin = null;
  first.unverifiedReason = '构造的缺口：这个块回核不到原文行';
  const mapped = toK1Model(model, out.composition, 'cli');
  assert.equal(mapped.uncited.length, 1, JSON.stringify(mapped.uncited));
  assert.deepEqual(
    mapped.model.sections.slice(1).map((section) => [section.title, section.ordinal, section.selector]),
    [['示例', 1, 'h/示例'], ['示例', 2, 'h/示例[2]']],
    'the uncited block changes nothing about the numbering',
  );
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(produced.entries.map((entry) => [String(entry.statement), entry.path]), [['第二节正文。', '/manual/cli/示例[2]']]);
});

test('a heading segment keeps the characters of its title: only paired marks at token edges go', async () => {
  const { mapped, produced } = await place({
    'book.adoc': [
      '= Synthetic',                 // 1
      '',                            // 2
      '== health_check 配置',         // 3
      '',                            // 4
      '甲。',                         // 5
      '',                            // 6
      '== C++ 接口',                  // 7
      '',                            // 8
      '乙。',                         // 9
      '',                            // 10
      '== C# 接口',                   // 11
      '',                            // 12
      '丙。',                         // 13
      '',                            // 14
      '== max_conn 与 min_conn',      // 15
      '',                            // 16
      '丁。',                         // 17
      '',                            // 18
      '== 步骤 #1',                   // 19
      '',                            // 20
      '戊。',                         // 21
      '',                            // 22
      '== *配置* _成员池_',            // 23
      '',                            // 24
      '己。',                         // 25
      '',                            // 26
      '== **demo pool add** *<name>*', // 27
      '',                            // 28
      '庚。',                         // 29
      '',                            // 30
    ].join('\n'),
  });
  assert.deepEqual(
    mapped.model.sections.slice(1).map((section) => [section.title, section.selector, section.ordinal]),
    [
      ['health_check 配置', 'h/health_check%20配置', 1],
      ['C++ 接口', 'h/C++%20接口', 1],
      ['C# 接口', 'h/C#%20接口', 1],
      ['max_conn 与 min_conn', 'h/max_conn%20与%20min_conn', 1],
      ['步骤 #1', 'h/步骤%20#1', 1],
      ['配置 成员池', 'h/配置%20成员池', 1],
      ['demo pool add <name>', 'h/demo%20pool%20add%20<name>', 1],
    ],
    JSON.stringify(mapped.model.sections.slice(1)),
  );
  // Two titles that differ only by a character the marks rule used to eat are two paths, told apart by their own text
  // and not by an ordinal.
  assert.deepEqual(
    produced.entries.map((entry) => [String(entry.statement), entry.path]),
    [
      ['甲。', '/manual/cli/health_check%20配置'],
      ['乙。', '/manual/cli/C++%20接口'],
      ['丙。', '/manual/cli/C#%20接口'],
      ['丁。', '/manual/cli/max_conn%20与%20min_conn'],
      ['戊。', '/manual/cli/步骤%20#1'],
      ['己。', '/manual/cli/配置%20成员池'],
      ['庚。', '/manual/cli/demo%20pool%20add%20<name>'],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.path])),
  );
  // A title is still never a signature, now that its marks are gone rather than merely eaten.
  assert.deepEqual(produced.entries.filter((entry) => entry.data.form === 'signature'), []);
});
